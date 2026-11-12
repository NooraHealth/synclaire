import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  attempt,
  FakeClock,
  normaliseOutcome,
  SynclaireClient,
  WatermelonClient,
  type Client,
  type Values,
} from './harness';
import type { DbDump } from '../helpers';

import { ModelServer } from './modelServer';

const IDS = {
  patient_sessions: ['s0', 's1', 's2'],
  nurses: ['n0', 'n1'],
  patient_session_nurses: ['l0', 'l1'],
} as const;
type Table = keyof typeof IDS;
const TABLE_NAMES = Object.keys(IDS) as Table[];

const tableArb = fc.constantFrom(...TABLE_NAMES);
const smallString = fc.constantFrom('a', 'b', 'c', '');

function valuesArb(table: Table): fc.Arbitrary<Values> {
  switch (table) {
    case 'patient_sessions':
      return fc.record(
        {
          feedback: fc.option(smallString, { nil: null }),
          no_of_patients: fc.integer({ min: 0, max: 3 }),
          location: fc.option(smallString, { nil: null }),
          date: fc.constantFrom(1, 2),
        },
        { requiredKeys: [] },
      );
    case 'nurses':
      return fc.record({ name: smallString, privacy_consent_timestamp: fc.option(fc.constant(5), { nil: null }) }, { requiredKeys: [] });
    default:
      return fc.record({ session_id: fc.constantFrom(...IDS.patient_sessions), nurse_id: fc.constantFrom(...IDS.nurses) }, { requiredKeys: [] });
  }
}

const rowRef = tableArb.chain(table => fc.record({ table: fc.constant(table), id: fc.constantFrom(...IDS[table]) }));
const withValues = tableArb.chain(table =>
  fc.record({ table: fc.constant(table), id: fc.constantFrom(...IDS[table]), values: valuesArb(table) }),
);

type Command =
  | { op: 'insert' | 'update' | 'serverUpsert'; table: Table; id: string; values: Values }
  | { op: 'markDeleted' | 'destroy' | 'serverDelete'; table: Table; id: string }
  | { op: 'markDeletedWhere'; sessionId: string }
  | { op: 'sync'; pushFails: boolean; racingEdit: { table: Table; id: string; values: Values } | null }
  | { op: 'tick'; ms: number }
  | { op: 'reset' };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: withValues.map(c => ({ op: 'insert' as const, ...c })) },
  { weight: 4, arbitrary: withValues.map(c => ({ op: 'update' as const, ...c })) },
  { weight: 2, arbitrary: rowRef.map(c => ({ op: 'markDeleted' as const, ...c })) },
  { weight: 1, arbitrary: rowRef.map(c => ({ op: 'destroy' as const, ...c })) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(...IDS.patient_sessions).map(sessionId => ({ op: 'markDeletedWhere' as const, sessionId })),
  },
  { weight: 3, arbitrary: withValues.map(c => ({ op: 'serverUpsert' as const, ...c })) },
  { weight: 2, arbitrary: rowRef.map(c => ({ op: 'serverDelete' as const, ...c })) },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('sync' as const),
      pushFails: fc.boolean(),
      racingEdit: fc.option(withValues, { nil: null, freq: 4 }),
    }),
  },
  { weight: 1, arbitrary: fc.integer({ min: -7_200_000, max: 7_200_000 }).map(ms => ({ op: 'tick' as const, ms })) },
  { weight: 1, arbitrary: fc.constant({ op: 'reset' as const }) },
);

const clock = new FakeClock();
const EMPTY: DbDump = { user_version: 0, ddl: [], local_storage: [], rows: {} };

async function apply(client: Client, server: ModelServer, cmd: Command) {
  switch (cmd.op) {
    case 'insert':
      return attempt(() => client.insert(cmd.table, { ...cmd.values, id: cmd.id }));
    case 'update':
      return attempt(() => client.update(cmd.table, cmd.id, cmd.values));
    case 'markDeleted':
      return attempt(() => client.markDeleted(cmd.table, cmd.id));
    case 'destroy':
      return attempt(() => client.destroyPermanently(cmd.table, cmd.id));
    case 'markDeletedWhere':
      return attempt(() => client.markDeletedWhere('patient_session_nurses', 'session_id', cmd.sessionId));
    case 'serverUpsert':
      server.upsert(cmd.table, cmd.id, cmd.values);
      return { ok: true };
    case 'serverDelete':
      server.delete(cmd.table, cmd.id);
      return { ok: true };
    case 'sync': {
      server.failNextPush = cmd.pushFails;
      const race = cmd.racingEdit;
      server.duringPush = race
        ? async () => {
            await attempt(() => client.update(race.table, race.id, race.values));
          }
        : undefined;
      const r = await client.sync(server);
      server.failNextPush = false;
      server.duringPush = undefined;
      return r;
    }
    case 'tick':
      return { ok: true };
    case 'reset':
      return attempt(() => client.reset());
    default:
      throw new Error('unknown command');
  }
}

describe('random interleavings agree with WatermelonDB', () => {
  beforeAll(() => clock.install());
  afterAll(() => clock.uninstall());

  it('database state, push payloads and outcomes match after every command', async () => {
    const stats = {
      remoteDeleteOfLocalRow: 0,
      remoteDeleteOfEditedRow: 0,
      mergeIntoEditedRow: 0,
      pushOk: 0,
      pushRejected: 0,
      editDuringPushKeptPending: 0,
      failedLocalOps: 0,
    };
    const record = (before: DbDump, after: DbDump, server: ModelServer, cmd: Command, outcome: { ok: boolean; pushed?: unknown[] }) => {
      if (cmd.op !== 'sync') {
        if (!outcome.ok) stats.failedLocalOps += 1;
        return;
      }
      const find = (d: DbDump, t: string, id: string) => d.rows[t]?.find(r => r.id === id);
      for (const [t, id] of server.lastPull.deleted) {
        const row = find(before, t, id);
        if (row) stats.remoteDeleteOfLocalRow += 1;
        if (row && row._status !== 'synced') stats.remoteDeleteOfEditedRow += 1;
      }
      for (const [t, id] of server.lastPull.updated) {
        if (find(before, t, id)?._changed) stats.mergeIntoEditedRow += 1;
      }
      if (outcome.pushed?.length) {
        if (outcome.ok) stats.pushOk += 1;
        else stats.pushRejected += 1;
      }
      const race = cmd.racingEdit;
      if (race && outcome.ok && find(after, race.table, race.id)?._status === 'updated') stats.editDuringPushKeptPending += 1;
    };
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.array(commandArb, { minLength: 1, maxLength: 30 }), async (seeded, randomCommands) => {
        const prelude: Command[] = seeded
          ? [
              ...TABLE_NAMES.flatMap(table =>
                IDS[table].map(id => ({ op: 'serverUpsert' as const, table, id, values: {} })),
              ),
              { op: 'sync', pushFails: false, racingEdit: null },
            ]
          : [];
        const commands = [...prelude, ...randomCommands];
        const wmClient = new WatermelonClient('in');
        const scClient = await SynclaireClient.open('in');
        const wmServer = new ModelServer();
        const scServer = new ModelServer();
        for (const [i, cmd] of commands.entries()) {
          if (cmd.op === 'tick') clock.t += cmd.ms;
          clock.advance(1000);
          const start = clock.t;
          const before = cmd.op === 'sync' ? wmClient.dump() : undefined;
          const a = await apply(wmClient, wmServer, cmd);
          record(before ?? EMPTY, cmd.op === 'sync' ? wmClient.dump() : EMPTY, wmServer, cmd, a);
          clock.t = start;
          const b = await apply(scClient, scServer, cmd);
          const context = `step ${i}: ${JSON.stringify(cmd)}`;
          expect(normaliseOutcome(b), context).toEqual(normaliseOutcome(a));
          if ('pushed' in a && 'pushed' in b) expect(JSON.stringify(b.pushed), context).toBe(JSON.stringify(a.pushed));
          expect(scClient.dump(), context).toEqual(wmClient.dump());
          expect(await scClient.hasUnsyncedChanges(), context).toBe(await wmClient.hasUnsyncedChanges());
        }
        await scClient.db.close();
      }),
      {
        numRuns: Number(process.env.SYNCLAIRE_PROPERTY_RUNS ?? 300),
        endOnFailure: true,
        ...(process.env.SYNCLAIRE_PROPERTY_SEED ? { seed: Number(process.env.SYNCLAIRE_PROPERTY_SEED), path: process.env.SYNCLAIRE_PROPERTY_PATH } : {}),
      },
    );
    console.info('[property] coverage', stats);
    for (const [event, count] of Object.entries(stats)) {
      expect(count, `scenario "${event}" was never generated; adjust the command weights`).toBeGreaterThan(0);
    }
  });
});
