import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFixture } from '../helpers';

import {
  attempt,
  FakeClock,
  normaliseOutcome,
  SynclaireClient,
  WatermelonClient,
  type Client,
  type PullResponse,
  type SyncOutcome,
  type SyncServer,
} from './harness';

interface Captured {
  request: { body?: Record<string, { created: Record<string, unknown>[] }> };
  response: { status: number; json: unknown };
}

const SEED = readFixture<{
  me: string;
  colleague: string;
  class_type: string;
  sessions: { own: string; own2: string; tagged_by_colleague: string };
}>('seed.json');

/** Replays one captured pull (and optionally a push status) per sync. */
class ScriptedServer implements SyncServer {
  constructor(
    private readonly pullFile: string,
    private readonly pushFile?: string,
  ) {}

  async pull(): Promise<PullResponse> {
    const c = readFixture<Captured>(this.pullFile);
    const json = c.response.json as PullResponse;
    return JSON.parse(JSON.stringify({ changes: json.changes, timestamp: json.timestamp }));
  }

  async push(): Promise<void> {
    if (!this.pushFile) return;
    const c = readFixture<Captured>(this.pushFile);
    if (c.response.status !== 200) throw new Error(`push ${c.response.status}: ${JSON.stringify(c.response.json)}`);
  }
}

const S2_PUSH = readFixture<Captured>('04-s2-push-push.json').request.body!;
const NEW_SESSION = S2_PUSH.patient_sessions!.created[0]!;
const NEW_LINKS = S2_PUSH.patient_session_nurses!.created;

type Pair = [Client, Client];

const clock = new FakeClock();

async function both<T>(pair: Pair, fn: (c: Client) => Promise<T>): Promise<[T, T]> {
  const a = await fn(pair[0]);
  const b = await fn(pair[1]);
  return [a, b];
}

function expectSameState(pair: Pair) {
  const [wm, sc] = pair.map(c => c.dump());
  expect(sc).toEqual(wm);
}

async function syncBoth(pair: Pair, pullFile: string, pushFile?: string): Promise<SyncOutcome> {
  const [a, b] = await both(pair, c => c.sync(new ScriptedServer(pullFile, pushFile)));
  expect(normaliseOutcome(b)).toEqual(normaliseOutcome(a));
  expect(b.pushed).toEqual(a.pushed);
  expect(JSON.stringify(b.pushed)).toBe(JSON.stringify(a.pushed));
  expectSameState(pair);
  return a;
}

async function opBoth(pair: Pair, fn: (c: Client) => Promise<unknown>) {
  const [a, b] = await both(pair, c => attempt(() => fn(c)));
  expect(normaliseOutcome(b)).toEqual(normaliseOutcome(a));
  expectSameState(pair);
}

describe('probe scenarios replayed against WatermelonDB and Synclaire', () => {
  let me: Pair;
  let colleague: Pair;

  beforeAll(async () => {
    clock.install();
    me = [new WatermelonClient('in'), await SynclaireClient.open('in')];
    colleague = [new WatermelonClient('in'), await SynclaireClient.open('in')];
  });

  afterAll(() => clock.uninstall());

  it('S1 first sync', async () => {
    const r = await syncBoth(me, '01-s1-first-pull.json');
    expect(r.ok).toBe(true);
    const dump = me[1].dump();
    expect(dump.rows.patient_sessions).toHaveLength(3);
    expect(dump.local_storage.map(l => l.key).sort()).toEqual([
      '__watermelon_last_pulled_at',
      '__watermelon_last_pulled_schema_version',
    ]);
  });

  it('S2 mixed local writes and push', async () => {
    clock.advance();
    await opBoth(me, async c => {
      await c.insert('patient_sessions', {
        id: NEW_SESSION.id as string,
        date: NEW_SESSION.date as number,
        class_type: SEED.class_type,
        created_by: SEED.me,
        no_of_participants: 12,
        no_of_estimated_res_signups: 3,
        location: 'Hall',
      });
      for (const link of NEW_LINKS) {
        await c.insert('patient_session_nurses', {
          id: link.id as string,
          session_id: link.session_id as string,
          nurse_id: link.nurse_id as string,
        });
      }
      await c.update('patient_sessions', SEED.sessions.own, { feedback: 'edited on device' });
      await c.markDeleted('patient_sessions', SEED.sessions.own2);
      await c.markDeletedWhere('patient_session_nurses', 'session_id', SEED.sessions.own);
      await c.update('nurses', SEED.me, { name: 'Renamed On Device' });
    });
    expect(await me[1].hasUnsyncedChanges()).toBe(await me[0].hasUnsyncedChanges());
    clock.advance();
    const r = await syncBoth(me, '03-s2-push-pull.json', '04-s2-push-push.json');
    expect(r.ok).toBe(true);
    const pushed = r.pushed[0] as typeof S2_PUSH;
    expect(Object.keys(pushed)).toEqual(Object.keys(S2_PUSH));
    expect(pushed.patient_sessions!.created.map(x => x.id)).toEqual([NEW_SESSION.id]);
    expect(await me[1].hasUnsyncedChanges()).toBe(false);
  });

  it('S3 echo of our own push applies cleanly', async () => {
    clock.advance();
    const r = await syncBoth(me, '06-s3-echo-pull.json');
    expect(r.ok).toBe(true);
    expect(r.pushed).toEqual([]);
  });

  it('S4 per-column merge', async () => {
    clock.advance();
    await opBoth(me, c => c.update('patient_sessions', SEED.sessions.own, { feedback: 'device edit S4' }));
    clock.advance();
    const r = await syncBoth(me, '07-s4-merge-pull.json', '08-s4-merge-push.json');
    expect(r.ok).toBe(true);
    const row = me[1].dump().rows.patient_sessions!.find(x => x.id === SEED.sessions.own)!;
    expect(row).toMatchObject({ no_of_participants: 99, feedback: 'device edit S4', _status: 'synced' });
  });

  it('S5 server edit between pull and push (400), then retry', async () => {
    clock.advance();
    await opBoth(me, c => c.update('patient_sessions', SEED.sessions.own, { feedback: 'device edit S5' }));
    clock.advance();
    const failed = await syncBoth(me, '10-s5-race-pull.json', '11-s5-race-push.json');
    expect(failed.ok).toBe(false);
    expect(await me[1].hasUnsyncedChanges()).toBe(true);
    clock.advance();
    const retry = await syncBoth(me, '12-s5-retry-pull.json', '13-s5-retry-push.json');
    expect(retry.ok).toBe(true);
  });

  it('S6 remote delete against a local edit', async () => {
    clock.advance();
    await opBoth(me, c =>
      c.update('patient_sessions', SEED.sessions.tagged_by_colleague, { feedback: 'device edit on soon-deleted' }),
    );
    clock.advance();
    const r = await syncBoth(me, '14-s6-delete-vs-edit-pull.json');
    expect(r.ok).toBe(true);
    expect(me[1].dump().rows.patient_sessions!.find(x => x.id === SEED.sessions.tagged_by_colleague)).toBeUndefined();
  });

  it('S7 device clock behind, colleague pulls', async () => {
    clock.advance();
    expect((await syncBoth(colleague, '16-s7-colleague-first-pull.json')).ok).toBe(true);
    const realNow = clock.t;
    clock.t = realNow - 3600 * 1000;
    await opBoth(me, c =>
      c.update('patient_sessions', NEW_SESSION.id as string, { feedback: 'edit from a device whose clock is 1h behind' }),
    );
    clock.t = realNow + 1000;
    const push = await syncBoth(me, '18-s7-me-skewed-push-pull.json', '19-s7-me-skewed-push-push.json');
    expect(push.ok).toBe(true);
    const pushedRow = (push.pushed[0] as typeof S2_PUSH).patient_sessions!.created.concat(
      (push.pushed[0] as Record<string, { updated: Record<string, unknown>[] }>).patient_sessions!.updated,
    )[0]!;
    expect(pushedRow.updated_at).toBe(realNow - 3600 * 1000);
    expect((await syncBoth(colleague, '20-s7-colleague-incremental-pull.json')).ok).toBe(true);
  });

  it('S8 device clock ahead blocks the next push', async () => {
    const s8: Pair = [new WatermelonClient('in'), await SynclaireClient.open('in')];
    clock.advance();
    await syncBoth(s8, '01-s1-first-pull.json');
    const realNow = clock.t;
    clock.t = realNow + 3600 * 1000;
    await opBoth(s8, c => c.update('patient_sessions', SEED.sessions.own, { feedback: 'S8 edit from fast clock' }));
    clock.t = realNow + 1000;
    expect((await syncBoth(s8, '02-s8-push-fast-clock-pull.json', '03-s8-push-fast-clock-push.json')).ok).toBe(true);
    clock.advance();
    await opBoth(s8, c => c.update('patient_sessions', SEED.sessions.own, { feedback: 'S8 second edit' }));
    const second = await syncBoth(s8, '04-s8-second-edit-pull.json', '05-s8-second-edit-push.json');
    expect(second.ok).toBe(false);
    expect(await s8[1].hasUnsyncedChanges()).toBe(true);
  });

  it('reset matches', async () => {
    await opBoth(me, c => c.reset());
    expect(me[1].dump().local_storage).toEqual([]);
    clock.advance();
    expect((await syncBoth(me, '01-s1-first-pull.json')).ok).toBe(true);
  });
});
