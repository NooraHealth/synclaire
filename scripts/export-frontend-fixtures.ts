/**
 * Builds WatermelonDB-created database files for hep-unified-frontend's upgrade-in-place tests.
 * No backend needed: WatermelonDB 0.27.1 syncs against the in-memory ModelServer.
 *
 * For each country, two files:
 * - `<code>.db`: the current schema. WatermelonDB pulls, then leaves edits it never pushed: a new
 *   session tagging two nurses, an edited session, a deleted session with its link, and an edited
 *   profile. This is a trainer on the current store build who upgrades while offline.
 * - `<code>-v1.db`: schema version 1 with one unpushed session. This is an install that never
 *   took the old schema migrations, so the app has to migrate it on open.
 *
 * Each file gets `<name>.json`, a manifest with what the app should read, and the push WatermelonDB
 * itself sends from a copy of the file (the oracle the frontend compares Synclaire's push to).
 *
 *   npm run fixtures:frontend [-- <out dir>]   (default ../hep-unified-frontend/src/test/fixtures/watermelon)
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FakeClock,
  WatermelonClient,
  type PullResponse,
  type SyncServer,
  type Values,
} from '../test/differential/harness';
import { ModelServer } from '../test/differential/modelServer';
import {
  COUNTRIES,
  watermelonModels,
  watermelonSchema,
  watermelonSchemaV1,
  type CountryCode,
} from '../test/fixtures/countries';
import { dumpFile, tmpDbPath } from '../test/helpers';

const require = createRequire(import.meta.url);
const Sqlite = require('better-sqlite3') as typeof import('better-sqlite3');
const wm = require('@nozbe/watermelondb') as any;
const SQLiteAdapter = require('@nozbe/watermelondb/adapters/sqlite').default as any;
const wmSync = require('@nozbe/watermelondb/sync') as any;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(process.argv[2] ?? path.join(ROOT, '../hep-unified-frontend/src/test/fixtures/watermelon'));
const TABLES = ['patient_sessions', 'nurses', 'patient_session_nurses'] as const;
const LAST_PULLED_KEY = '__watermelon_last_pulled_at';

type PushIds = Record<string, { created: string[]; updated: string[]; deleted: string[] }>;

export interface FrontendFixtureManifest {
  country: CountryCode;
  variant: 'current' | 'v1';
  file: string;
  userId: string;
  schemaVersion: number;
  lastPulledAt: string;
  /** Sessions the list should show (not deleted), sorted. */
  visibleSessionIds: string[];
  /** Raw column values the app should read back, by table and id. */
  expectRows: Record<string, Record<string, Values>>;
  /** Nurse ids tagged on each session, sorted. */
  taggedNurses: Record<string, string[]>;
  /** Ids WatermelonDB pushed from a copy of this file. */
  push: PushIds;
}

const clock = new FakeClock();

/** Superset of every country's columns; WatermelonDB drops the ones a schema doesn't have. */
function sessionValues(overrides: Values = {}): Values {
  return {
    date: 1_735_000_000_000,
    time_slot: 'morning',
    created_by: 'me',
    location: 'loc-1',
    class_type: 'class-1',
    health_topic: 'topic-1',
    intervention_type: 'intervention-1',
    supporting_activity: 'activity-1',
    no_of_participants: 12,
    no_of_male_participants: 3,
    no_of_estimated_res_signups: 2,
    no_of_patients: 5,
    no_of_ncd_patients: 1,
    no_of_caregivers: 4,
    total_no_of_caregivers: 4,
    no_of_male_caregivers: 1,
    no_of_anc_mothers: 2,
    no_of_pnc_mothers: 1,
    res_photo_count: 0,
    session_photo_count: 0,
    feedback: null,
    created_at: 1_735_000_000_000,
    updated_at: 1_735_000_000_000,
    ...overrides,
  };
}

function nurseValues(name: string): Values {
  return {
    number: '9999999999',
    name,
    state: 'state-1',
    province: 'province-1',
    designation: 'designation-1',
    facility: 'facility-1',
    facility_type: 'facility-type-1',
    condition_area: 'condition-1',
    department: 'department-1',
    date_of_tot: 1_700_000_000_000,
    date_of_birth: 600_000_000_000,
    account_status: 'active',
    privacy_consent_timestamp: 1_710_000_000_000,
  };
}

function seedServer(): ModelServer {
  const server = new ModelServer();
  server.upsert('nurses', 'me', nurseValues('Demo Nurse'));
  server.upsert('nurses', 'col', nurseValues('Colleague'));
  for (const id of ['s-synced', 's-edit', 's-delete']) {
    server.upsert('patient_sessions', id, sessionValues());
    server.upsert('patient_session_nurses', `l-${id}`, { session_id: id, nurse_id: 'me' });
  }
  return server;
}

/** Accepts one push and records it; pull returns no changes. */
function capturingServer(): SyncServer & { pushed: PushIds | null } {
  let time = 1_000_000;
  const server = {
    pushed: null as PushIds | null,
    async pull(): Promise<PullResponse> {
      return { changes: {}, timestamp: ++time };
    },
    async push(changes: unknown) {
      const c = changes as Record<string, { created: Values[]; updated: Values[]; deleted: string[] }>;
      server.pushed = Object.fromEntries(
        TABLES.map(t => [
          t,
          {
            created: c[t]!.created.map(r => r.id as string).sort(),
            updated: c[t]!.updated.map(r => r.id as string).sort(),
            deleted: [...c[t]!.deleted].sort(),
          },
        ]),
      );
    },
  };
  return server;
}

async function watermelonPush(code: CountryCode, file: string): Promise<PushIds> {
  const copy = tmpDbPath(`oracle-${code}`);
  fs.copyFileSync(file, copy);
  const server = capturingServer();
  const outcome = await new WatermelonClient(code, copy).sync(server);
  if (!outcome.ok || !server.pushed) throw new Error(`[${code}] oracle sync failed: ${outcome.error}`);
  return server.pushed;
}

function rowsOf(file: string, table: string, ids: string[], columns: string[]): Record<string, Values> {
  const dump = dumpFile(file, [table]);
  const out: Record<string, Values> = {};
  for (const id of ids) {
    const row = dump.rows[table]!.find(r => r.id === id);
    if (!row) throw new Error(`${table}#${id} missing`);
    out[id] = Object.fromEntries(columns.filter(c => c in row).map(c => [c, row[c] as Values[string]]));
  }
  return out;
}

function tagged(file: string, sessionIds: string[]): Record<string, string[]> {
  const links = dumpFile(file, ['patient_session_nurses']).rows.patient_session_nurses!;
  return Object.fromEntries(
    sessionIds.map(id => [
      id,
      links
        .filter(l => l.session_id === id && l._status !== 'deleted')
        .map(l => l.nurse_id as string)
        .sort(),
    ]),
  );
}

async function write(name: string, work: string, manifest: Omit<FrontendFixtureManifest, 'file' | 'schemaVersion' | 'lastPulledAt' | 'push'>) {
  const out = path.join(OUT_DIR, `${name}.db`);
  fs.rmSync(out, { force: true });
  const src = new Sqlite(work, { readonly: true });
  src.prepare('VACUUM INTO ?').run(out);
  src.close();

  const dump = dumpFile(out, [...TABLES]);
  const lastPulledAt = dump.local_storage.find(l => l.key === LAST_PULLED_KEY)?.value;
  if (!lastPulledAt) throw new Error(`[${name}] no ${LAST_PULLED_KEY}`);

  const full: FrontendFixtureManifest = {
    ...manifest,
    file: `${name}.db`,
    schemaVersion: dump.user_version,
    lastPulledAt,
    push: await watermelonPush(manifest.country, out),
  };
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), `${JSON.stringify(full, null, 2)}\n`);
  console.log(`${name}.db: schema v${full.schemaVersion}, sessions ${full.visibleSessionIds.join(', ')}`);
}

async function current(code: CountryCode) {
  const work = tmpDbPath(`frontend-${code}`);
  const client = new WatermelonClient(code, work);
  const first = await client.sync(seedServer());
  if (!first.ok) throw new Error(`[${code}] first sync failed: ${first.error}`);

  clock.advance();
  const now = clock.t;
  // WatermelonDB stores columns as a name → schema map on the table.
  const columns = watermelonSchema(code).tables.patient_sessions!.columns;
  const values = sessionValues({ date: now, no_of_participants: 7, feedback: 'Added offline', created_at: now, updated_at: now });
  await client.insert('patient_sessions', {
    id: 's-new',
    ...Object.fromEntries(Object.entries(values).filter(([k]) => k in columns)),
  });
  await client.insert('patient_session_nurses', { id: 'l-s-new-me', session_id: 's-new', nurse_id: 'me' });
  await client.insert('patient_session_nurses', { id: 'l-s-new-col', session_id: 's-new', nurse_id: 'col' });
  await client.update('patient_sessions', 's-edit', { feedback: 'Edited offline', updated_at: now });
  await client.markDeleted('patient_sessions', 's-delete');
  await client.markDeletedWhere('patient_session_nurses', 'session_id', 's-delete');
  await client.update('nurses', 'me', { name: 'Demo Nurse (edited offline)' });
  if (!(await client.hasUnsyncedChanges())) throw new Error(`[${code}] expected pending changes`);

  const visible = ['s-edit', 's-new', 's-synced'];
  await write(code, work, {
    country: code,
    variant: 'current',
    userId: 'me',
    visibleSessionIds: visible,
    expectRows: {
      patient_sessions: rowsOf(work, 'patient_sessions', visible, ['date', 'feedback', 'no_of_participants', 'created_by', 'class_type', '_status']),
      nurses: rowsOf(work, 'nurses', ['me'], ['name', 'number', 'account_status', 'privacy_consent_timestamp', '_status']),
    },
    taggedNurses: tagged(work, visible),
  });
}

async function v1(code: CountryCode) {
  const work = tmpDbPath(`frontend-${code}-v1`);
  const db = new wm.Database({
    adapter: new SQLiteAdapter({ dbName: work, schema: watermelonSchemaV1(code) }),
    modelClasses: watermelonModels(),
  });
  const server = seedServer();
  await wmSync.synchronize({
    database: db,
    sendCreatedAsUpdated: true,
    pullChanges: ({ lastPulledAt }: { lastPulledAt: number | null }) => server.pull(lastPulledAt),
    pushChanges: ({ changes, lastPulledAt }: { changes: unknown; lastPulledAt: number }) => server.push(changes, lastPulledAt),
  });

  clock.advance();
  const now = clock.t;
  await db.write(async () => {
    await db.get('patient_sessions').create((r: any) => {
      r._raw.id = 's-old-app';
      for (const [k, v] of Object.entries(sessionValues({ date: now, feedback: 'Added on an old app version', created_at: now, updated_at: now }))) {
        if (r._raw[k] !== undefined) r._setRaw(k, v);
      }
    });
    await db.get('patient_session_nurses').create((r: any) => {
      r._raw.id = 'l-s-old-app';
      r._setRaw('session_id', 's-old-app');
      r._setRaw('nurse_id', 'me');
    });
  });

  const visible = ['s-delete', 's-edit', 's-old-app', 's-synced'];
  await write(`${code}-v1`, work, {
    country: code,
    variant: 'v1',
    userId: 'me',
    visibleSessionIds: visible,
    expectRows: {
      patient_sessions: rowsOf(work, 'patient_sessions', ['s-old-app'], ['date', 'feedback', 'created_by', '_status']),
      nurses: rowsOf(work, 'nurses', ['me'], ['name', 'number', 'account_status', '_status']),
    },
    taggedNurses: tagged(work, ['s-old-app']),
  });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
clock.install();
try {
  for (const code of COUNTRIES) {
    await current(code);
    await v1(code);
  }
} finally {
  clock.uninstall();
}
console.log(`wrote ${COUNTRIES.length * 2} fixtures to ${OUT_DIR}`);
