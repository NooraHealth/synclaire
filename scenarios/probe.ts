/**
 * The .sync-probe scenarios as a platform-neutral script. Used by the Node integration suite
 * (test/integration) and by the Expo example app on iOS/Android, so both run identical steps.
 * The expected outcomes are the ones WatermelonDB 0.27.1 produced against the real backend.
 */
import { hasUnsyncedChanges, Q, synchronize, uuidv4, type Database, type Schema, type SyncLog } from 'synclaire';

export interface BackendSeed {
  token: string;
  colleague_token: string;
  me: string;
  colleague: string;
  class_type: string;
  sessions: { own: string; own2: string; tagged_by_colleague: string; not_mine: string; deleted: string };
}

/** Server-side edits a device cannot make itself; each maps to one fixed SQL statement. */
export type ControlAction = 'setPatients99' | 'bumpUpdatedAtAhead' | 'softDelete' | 'readSession';

/** Column used for S2 insert / S4 merge. Indonesia's client schema has no `no_of_patients`. */
export type SessionCountColumn = 'no_of_patients' | 'no_of_participants';

const COUNT_COLUMNS = new Set<SessionCountColumn>(['no_of_patients', 'no_of_participants']);
const UUID = /^[0-9a-f-]{36}$/i;

export function controlSql(
  action: ControlAction,
  uuid: string,
  countColumn: SessionCountColumn = 'no_of_patients',
): string {
  if (!UUID.test(uuid) || !COUNT_COLUMNS.has(countColumn)) throw new Error('invalid control request');
  switch (action) {
    case 'setPatients99':
      return `update app_backend_patienttrainingsession set ${countColumn}=99, updated_at=now() where uuid='${uuid}'`;
    case 'bumpUpdatedAtAhead':
      return `update app_backend_patienttrainingsession set updated_at=now() + interval '1 second' where uuid='${uuid}'`;
    case 'softDelete':
      return `update app_backend_patienttrainingsession set is_deleted=true, deleted_at=now() where uuid='${uuid}'`;
    case 'readSession':
      return `select coalesce(${countColumn}::text, '') || '|' || coalesce(feedback, '') from app_backend_patienttrainingsession where uuid='${uuid}'`;
    default:
      throw new Error('invalid control request');
  }
}

export interface ScenarioEnv {
  baseUrl: string;
  seed: BackendSeed;
  /**
   * Numeric session column present in both this country's Synclaire schema and the Django model.
   * Defaults to `no_of_patients` (India, Nepal, Bangladesh). Indonesia uses `no_of_participants`.
   */
  countColumn?: SessionCountColumn;
  /** Opens a fresh database for one device. `now` must be used as the database clock. */
  openDatabase: (name: string, now: () => number) => Promise<Database<Schema>>;
  control: (action: ControlAction, uuid: string) => Promise<string>;
  log?: (line: string) => void;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  error?: string;
  ms: number;
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${message}`);
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export class Device {
  offsetMs = 0;
  readonly pulledTables: string[][] = [];
  db!: Database<Schema>;

  constructor(
    private readonly env: ScenarioEnv,
    private readonly token: string,
  ) {}

  async open(name: string) {
    this.db = await this.env.openDatabase(name, () => Date.now() + this.offsetMs);
    return this;
  }

  private async http(method: string, url: string, body?: unknown) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Token ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, json };
  }

  async sync(hooks: { beforePush?: () => Promise<void> } = {}) {
    const log: SyncLog = {};
    try {
      await synchronize({
        database: this.db,
        sendCreatedAsUpdated: true,
        log,
        logger: { warn: () => undefined, error: () => undefined },
        pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
          const qs =
            `last_pulled_at=${encodeURIComponent(String(lastPulledAt))}` +
            `&schema_version=${schemaVersion}&migration=${encodeURIComponent(encodeURIComponent(JSON.stringify(migration)))}`;
          const r = await this.http('GET', `${this.env.baseUrl}/sync/?${qs}`);
          if (r.status !== 200) throw new Error(`pull ${r.status}: ${JSON.stringify(r.json)}`);
          const json = r.json as { changes: Record<string, never>; timestamp: number };
          this.pulledTables.push(Object.keys(json.changes));
          return { changes: json.changes, timestamp: json.timestamp };
        },
        pushChanges: async ({ changes, lastPulledAt }) => {
          if (hooks.beforePush) await hooks.beforePush();
          const r = await this.http('POST', `${this.env.baseUrl}/sync/?last_pulled_at=${lastPulledAt}`, changes);
          if (r.status !== 200) throw new Error(`push ${r.status}: ${JSON.stringify(r.json)}`);
        },
      });
      return { ok: true as const, log };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, log };
    }
  }
}

type Step = { name: string; run: () => Promise<void> };

/** Runs all scenarios in order (they build on each other) and reports each step. */
export async function runProbeScenarios(env: ScenarioEnv, schemaVersion: number): Promise<ScenarioResult[]> {
  const { seed } = env;
  const countColumn = env.countColumn ?? 'no_of_patients';
  const S = seed.sessions;
  const suffix = uuidv4().slice(0, 8);
  const me = new Device(env, seed.token);
  const colleague = new Device(env, seed.colleague_token);
  const newId = uuidv4();

  const expectOk = async <R extends { ok: boolean; error?: string }>(p: Promise<R>, label: string): Promise<R> => {
    const r = await p;
    check(r.ok, `${label} should succeed (${r.error ?? ''})`);
    return r;
  };

  const steps: Step[] = [
    {
      name: 'S1 first sync',
      run: async () => {
        await me.open(`me-${suffix}`);
        await expectOk(me.sync(), 'first sync');
        // Other runs (e.g. the example app's in-place check) may have pushed extra sessions for this
        // nurse, so check the seeded ones rather than the exact set.
        const seeded = [S.own, S.own2, S.tagged_by_colleague];
        const ids = (await me.db.query('patient_sessions', Q.where('id', Q.oneOf([...seeded, S.not_mine, S.deleted])))).map(r => r.id);
        check(sameSet(ids, seeded), `sessions ${ids.join(',')}`);
        check((await me.db.count('nurses')) === 2, 'two nurses');
        // Five links on the seeded sessions plus a dangling link to the soft-deleted session, which
        // the backend still sends (WatermelonDB saw the same six).
        const links = await me.db.count('patient_session_nurses', Q.where('session_id', Q.oneOf([...seeded, S.deleted])));
        check(links === 6, `six session-nurse links (${links})`);
        check((await me.db.get('patient_sessions', S.deleted)) === null, 'soft-deleted session not sent');
        check(me.pulledTables[0]!.includes('patients'), 'server sends unknown tables, which are skipped');
        check(
          (await me.db.localStorage.get('__watermelon_last_pulled_schema_version')) === String(schemaVersion),
          'schema version saved on first sync',
        );
      },
    },
    {
      name: 'S2 mixed local writes and push',
      run: async () => {
        await me.db.write(async tx => {
          await tx.insert('patient_sessions', {
            id: newId,
            date: Date.now(),
            class_type: seed.class_type,
            created_by: seed.me,
            [countColumn]: 4,
          });
          for (const nurse of [seed.me, seed.colleague]) {
            await tx.insert('patient_session_nurses', { session_id: newId, nurse_id: nurse });
          }
          await tx.update('patient_sessions', S.own, { feedback: 'edited on device' });
          await tx.markDeleted('patient_sessions', S.own2);
          await tx.markDeletedWhere('patient_session_nurses', Q.where('session_id', S.own), Q.where('nurse_id', seed.colleague));
          await tx.update('nurses', seed.me, { name: 'Renamed On Device' });
        });
        check(await hasUnsyncedChanges({ database: me.db }), 'pending before push');
        await expectOk(me.sync(), 'push');
        check(!(await hasUnsyncedChanges({ database: me.db })), 'nothing pending after push');
        check((await env.control('readSession', S.own)).endsWith('|edited on device'), 'server has the edit');
      },
    },
    {
      name: 'S3 echo',
      run: async () => {
        await expectOk(me.sync(), 'echo sync');
        check(!(await hasUnsyncedChanges({ database: me.db })), 'echo leaves nothing pending');
        check((await me.db.find('patient_sessions', S.own)).feedback === 'edited on device', 'echo keeps value');
      },
    },
    {
      name: 'S4 per-column merge',
      run: async () => {
        await env.control('setPatients99', S.own);
        await me.db.write(tx => tx.update('patient_sessions', S.own, { feedback: 'device edit S4' }));
        const r = await expectOk(me.sync(), 'merge sync');
        check(r.log.resolvedConflicts?.length === 1, 'one resolved conflict logged');
        const row = await me.db.find('patient_sessions', S.own);
        check(
          row[countColumn] === 99 && row.feedback === 'device edit S4' && row.syncStatus === 'synced',
          'merged row',
        );
        check((await env.control('readSession', S.own)) === '99|device edit S4', 'server row merged');
      },
    },
    {
      name: 'S5 server edit between pull and push (400), retry',
      run: async () => {
        await me.db.write(tx => tx.update('patient_sessions', S.own, { feedback: 'device edit S5' }));
        const r = await me.sync({ beforePush: async () => void (await env.control('bumpUpdatedAtAhead', S.own)) });
        check(!r.ok && (r.error ?? '').includes('push 400'), `push rejected with 400 (${r.error ?? 'ok'})`);
        check(await hasUnsyncedChanges({ database: me.db }), 'edit still pending after 400');
        await new Promise(res => setTimeout(() => res(undefined), 1500));
        await expectOk(me.sync(), 'retry');
        check(!(await hasUnsyncedChanges({ database: me.db })), 'retry pushed the edit');
      },
    },
    {
      name: 'S6 remote delete against a local edit',
      run: async () => {
        await me.db.write(tx => tx.update('patient_sessions', S.tagged_by_colleague, { feedback: 'device edit on soon-deleted' }));
        await env.control('softDelete', S.tagged_by_colleague);
        await expectOk(me.sync(), 'delete sync');
        check((await me.db.get('patient_sessions', S.tagged_by_colleague)) === null, 'row removed despite local edit');
      },
    },
    {
      name: 'S7 device clock behind, colleague pulls',
      run: async () => {
        await colleague.open(`colleague-${suffix}`);
        await expectOk(colleague.sync(), 'colleague first sync');
        check((await colleague.db.get('patient_sessions', S.own)) !== null, 'colleague still gets the untagged session');
        check((await colleague.db.get('patient_sessions', newId)) !== null, 'colleague gets the new session');
        me.offsetMs = -3600 * 1000;
        await me.db.write(tx => tx.update('patient_sessions', newId, { feedback: 'edit from a device whose clock is 1h behind' }));
        me.offsetMs = 0;
        await expectOk(me.sync(), 'skewed push');
        await expectOk(colleague.sync(), 'colleague incremental');
        const seen = (await colleague.db.find('patient_sessions', newId)).feedback;
        check(seen !== 'edit from a device whose clock is 1h behind', 'colleague does not see the skewed edit (backend issue)');
      },
    },
    {
      name: 'S8 device clock ahead blocks the next push',
      run: async () => {
        const fast = await new Device(env, seed.token).open(`fast-${suffix}`);
        await expectOk(fast.sync(), 'first sync');
        fast.offsetMs = 3600 * 1000;
        await fast.db.write(tx => tx.update('patient_sessions', S.own, { feedback: 'S8 edit from fast clock' }));
        fast.offsetMs = 0;
        await expectOk(fast.sync(), 'fast-clock push');
        await fast.db.write(tx => tx.update('patient_sessions', S.own, { feedback: 'S8 second edit' }));
        const r = await fast.sync();
        check(!r.ok && (r.error ?? '').includes('push 400'), `next push blocked (${r.error ?? 'ok'})`);
        check(await hasUnsyncedChanges({ database: fast.db }), 'edit stays pending');
      },
    },
  ];

  const results: ScenarioResult[] = [];
  for (const step of steps) {
    const started = Date.now();
    try {
      await step.run();
      results.push({ name: step.name, ok: true, ms: Date.now() - started });
      env.log?.(`ok   ${step.name}`);
    } catch (e) {
      results.push({ name: step.name, ok: false, error: (e as Error).message, ms: Date.now() - started });
      env.log?.(`FAIL ${step.name}: ${(e as Error).message}`);
      break;
    }
  }
  return results;
}
