/**
 * Builds the WatermelonDB-generated database the example app opens in place.
 *
 * For each running backend (test/integration/.state/<country>.json): WatermelonDB 0.27.1 syncs as
 * the seeded nurse, then makes local changes it does not push (a new session with two nurse links
 * and an edit to an existing session). The file is written to example/fixtures/<country>.db with
 * a manifest describing what the app should find and push.
 *
 *   node --import tsx scripts/prepare-watermelon-fixture.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { BackendSeed } from '../scenarios/probe';
import { WatermelonClient, type PullResponse, type SyncServer } from '../test/differential/harness';
import type { CountryCode } from '../test/fixtures/countries';
import { tmpDbPath } from '../test/helpers';

const require = createRequire(import.meta.url);
const Sqlite = require('better-sqlite3') as typeof import('better-sqlite3');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(ROOT, 'test/integration/.state');
const OUT_DIR = path.join(ROOT, 'example/fixtures');
const CODES: Record<string, CountryCode> = { india: 'in', nepal: 'np', bangladesh: 'bd', indonesia: 'id' };

export interface FixtureManifest {
  key: string;
  code: CountryCode;
  /** WatermelonDB `dbName` the frontend would use; the file is `<dbName>.db`. */
  dbName: string;
  schemaVersion: number;
  lastPulledAt: string;
  sessionCount: number;
  pending: { editedSessionId: string; feedback: string; newSessionId: string; newSessionLinks: number };
}

function httpServer(baseUrl: string, token: string): SyncServer {
  const headers = { Authorization: `Token ${token}`, 'Content-Type': 'application/json' };
  return {
    async pull(lastPulledAt) {
      const migration = encodeURIComponent(encodeURIComponent('null'));
      const res = await fetch(`${baseUrl}/sync/?last_pulled_at=${lastPulledAt}&schema_version=0&migration=${migration}`, { headers });
      if (res.status !== 200) throw new Error(`pull ${res.status}: ${await res.text()}`);
      return (await res.json()) as PullResponse;
    },
    async push(changes, lastPulledAt) {
      const res = await fetch(`${baseUrl}/sync/?last_pulled_at=${lastPulledAt}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(changes),
      });
      if (res.status !== 200) throw new Error(`push ${res.status}: ${await res.text()}`);
    },
  };
}

async function prepare(key: string, state: { baseUrl: string; seed: BackendSeed }) {
  const code = CODES[key];
  if (!code) throw new Error(`unknown country ${key}`);
  const { seed } = state;
  const work = tmpDbPath(`fixture-${code}`);
  const client = new WatermelonClient(code, work);

  const first = await client.sync(httpServer(state.baseUrl, seed.token));
  if (!first.ok) throw new Error(`[${key}] watermelon first sync failed: ${first.error}`);

  const newSessionId = crypto.randomUUID();
  const feedback = `pending from watermelon ${new Date().toISOString()}`;
  const now = Date.now();
  await client.insert('patient_sessions', {
    id: newSessionId,
    date: now,
    class_type: seed.class_type,
    created_by: seed.me,
    no_of_patients: 7,
    created_at: now,
    updated_at: now,
  });
  for (const nurse of [seed.me, seed.colleague]) {
    await client.insert('patient_session_nurses', { id: crypto.randomUUID(), session_id: newSessionId, nurse_id: nurse });
  }
  await client.update('patient_sessions', seed.sessions.own, { feedback, updated_at: Date.now() });
  if (!(await client.hasUnsyncedChanges())) throw new Error('expected pending changes');

  const dbName = `${code}_${seed.me}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${key}.db`);
  fs.rmSync(out, { force: true });
  const src = new Sqlite(work, { readonly: true });
  src.prepare('VACUUM INTO ?').run(out);
  const schemaVersion = src.pragma('user_version', { simple: true }) as number;
  const lastPulledAt = (
    src.prepare(`select value from local_storage where key = '__watermelon_last_pulled_at'`).get() as { value: string }
  ).value;
  const sessionCount = (src.prepare(`select count(*) as n from patient_sessions where _status != 'deleted'`).get() as { n: number }).n;
  src.close();

  const copy = new Sqlite(out, { readonly: true });
  const copiedVersion = copy.pragma('user_version', { simple: true });
  copy.close();
  if (copiedVersion !== schemaVersion) throw new Error(`user_version lost in copy (${copiedVersion} != ${schemaVersion})`);

  const manifest: FixtureManifest = {
    key,
    code,
    dbName,
    schemaVersion,
    lastPulledAt,
    sessionCount,
    pending: { editedSessionId: seed.sessions.own, feedback, newSessionId, newSessionLinks: 2 },
  };
  fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), JSON.stringify(manifest, null, 2));
  console.log(`[${key}] wrote ${path.relative(ROOT, out)} (schema v${schemaVersion}, ${sessionCount} sessions, 4 pending rows)`);
}

const files = fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json')) : [];
if (!files.length) {
  console.error('no backend state; run scripts/backend-up.sh first');
  process.exit(1);
}
for (const f of files) {
  await prepare(f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')));
}
