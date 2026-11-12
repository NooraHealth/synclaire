/**
 * Synclaire vs WatermelonDB 0.27.1 in Node, both on better-sqlite3 with file-backed databases and
 * the India schema. Each case runs on fresh databases several times; the median is reported.
 *
 *   npm run bench            (BENCH_RUNS=7 to change the number of runs)
 */
import { Q, synchronize, type Database, type Schema } from '../src';
import { SynclaireClient, WatermelonClient } from '../test/differential/harness';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wm = require('@nozbe/watermelondb') as any;
const wmSync = require('@nozbe/watermelondb/sync') as any;

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const PULL_RECORDS = 5000;
const LOCAL_CHANGES = 1000;
const PAGES = 100;
const PAGE_SIZE = 50;
const NURSE = 'nurse-0';
const CLASS_TYPE = 'class-0';

type Raw = Record<string, string | number | null>;

function sessionRaws(n: number, version = 0): Raw[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    date: 1_700_000_000_000 + i * 60_000,
    time_slot: 'morning',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000 + version,
    created_by: NURSE,
    location: null,
    class_type: CLASS_TYPE,
    no_of_participants: i % 30,
    no_of_estimated_res_signups: 0,
    no_of_patients: (i + version) % 20,
    no_of_caregivers: i % 5,
    session_photo_count: 0,
    feedback: i % 3 ? null : `feedback ${i} v${version}`,
  }));
}

function pullOf(sessions: Raw[], kind: 'created' | 'updated') {
  return {
    changes: {
      patient_sessions: { created: kind === 'created' ? sessions : [], updated: kind === 'updated' ? sessions : [], deleted: [] },
      nurses: { created: [], updated: [], deleted: [] },
      patient_session_nurses: { created: [], updated: [], deleted: [] },
    },
    timestamp: Date.now(),
  };
}

const EMPTY_PULL = () => pullOf([], 'created');

interface Impl {
  name: 'synclaire' | 'watermelon';
  open(): Promise<unknown>;
  sync(db: any, pull: () => ReturnType<typeof pullOf>): Promise<void>;
  insertSessions(db: any, n: number): Promise<void>;
  page(db: any, p: number): Promise<unknown[]>;
}

const synclaire: Impl = {
  name: 'synclaire',
  open: async () => (await SynclaireClient.open('in')).db,
  async sync(db: Database<Schema>, pull) {
    await synchronize({ database: db, sendCreatedAsUpdated: true, pullChanges: async () => pull(), pushChanges: async () => undefined });
  },
  async insertSessions(db: Database<Schema>, n) {
    await db.write(async tx => {
      for (let i = 0; i < n; i++) {
        await tx.insert('patient_sessions', { date: i, class_type: CLASS_TYPE, created_by: NURSE, no_of_patients: i % 20 });
      }
    });
  },
  page: (db: Database<Schema>, p) => db.query('patient_sessions', Q.sortBy('date', 'desc'), Q.take(PAGE_SIZE), Q.skip(p * PAGE_SIZE)),
};

const watermelon: Impl = {
  name: 'watermelon',
  open: async () => new WatermelonClient('in').db,
  async sync(db, pull) {
    await wmSync.synchronize({ database: db, sendCreatedAsUpdated: true, pullChanges: async () => pull(), pushChanges: async () => undefined });
  },
  async insertSessions(db, n) {
    const sessions = db.get('patient_sessions');
    await db.write(() =>
      db.batch(
        Array.from({ length: n }, (_, i) =>
          sessions.prepareCreate((r: any) => {
            r._setRaw('date', i);
            r._setRaw('class_type', CLASS_TYPE);
            r._setRaw('created_by', NURSE);
            r._setRaw('no_of_patients', i % 20);
          }),
        ),
      ),
    );
  },
  page: (db, p) =>
    db
      .get('patient_sessions')
      .query(wm.Q.sortBy('date', wm.Q.desc), wm.Q.skip(p * PAGE_SIZE), wm.Q.take(PAGE_SIZE))
      .fetch(),
};

interface Case {
  name: string;
  /** Runs untimed setup, then returns the timed operation. */
  prepare(impl: Impl): Promise<() => Promise<void>>;
}

const created = sessionRaws(PULL_RECORDS);
const updated = sessionRaws(PULL_RECORDS, 1);

const CASES: Case[] = [
  {
    name: `first pull: apply ${PULL_RECORDS} created sessions`,
    async prepare(impl) {
      const db = await impl.open();
      return () => impl.sync(db, () => pullOf(created, 'created'));
    },
  },
  {
    name: `incremental pull: apply ${PULL_RECORDS} updated sessions`,
    async prepare(impl) {
      const db = await impl.open();
      await impl.sync(db, () => pullOf(created, 'created'));
      return () => impl.sync(db, () => pullOf(updated, 'updated'));
    },
  },
  {
    name: `insert ${LOCAL_CHANGES} sessions in one write`,
    async prepare(impl) {
      const db = await impl.open();
      await impl.sync(db, EMPTY_PULL);
      return () => impl.insertSessions(db, LOCAL_CHANGES);
    },
  },
  {
    name: `push ${LOCAL_CHANGES} local changes (sync with empty pull)`,
    async prepare(impl) {
      const db = await impl.open();
      await impl.sync(db, EMPTY_PULL);
      await impl.insertSessions(db, LOCAL_CHANGES);
      return () => impl.sync(db, EMPTY_PULL);
    },
  },
  {
    name: `${PAGES} pages of ${PAGE_SIZE} sessions sorted by date (${PULL_RECORDS} rows)`,
    async prepare(impl) {
      const db = await impl.open();
      await impl.sync(db, () => pullOf(created, 'created'));
      return async () => {
        for (let p = 0; p < PAGES; p++) {
          const rows = await impl.page(db, p);
          if (rows.length !== PAGE_SIZE) throw new Error(`${impl.name}: page ${p} has ${rows.length} rows`);
        }
      };
    },
  },
];

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

const rows: string[] = [];
let slower = 0;
for (const c of CASES) {
  const ms: Record<string, number[]> = { synclaire: [], watermelon: [] };
  for (let r = 0; r < RUNS; r++) {
    for (const impl of r % 2 ? [watermelon, synclaire] : [synclaire, watermelon]) {
      const op = await c.prepare(impl);
      const started = performance.now();
      await op();
      ms[impl.name]!.push(performance.now() - started);
    }
  }
  const s = median(ms.synclaire!);
  const w = median(ms.watermelon!);
  if (s > w * 1.1) slower++;
  rows.push(`| ${c.name} | ${s.toFixed(0)} | ${w.toFixed(0)} | ${(w / s).toFixed(2)}x |`);
  console.error(`done: ${c.name}`);
}

console.log(`Median of ${RUNS} runs, milliseconds (Node ${process.version}, ${process.platform}/${process.arch}).\n`);
console.log('| Case | Synclaire | WatermelonDB | Speed-up |');
console.log('| --- | ---: | ---: | ---: |');
for (const r of rows) console.log(r);
if (slower) {
  console.log(`\n${slower} case(s) where Synclaire is more than 10% slower.`);
  process.exitCode = 1;
}
