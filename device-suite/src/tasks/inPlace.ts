import { Directory, File, Paths } from 'expo-file-system';
import { hasUnsyncedChanges, Q } from 'synclaire';
import { watermelonDatabaseLocation } from 'synclaire/expo';

import { Device } from '../../../scenarios/probe';
import { apiUrl, control, CONTROL_URL, PLATFORM, type Backend } from '../host';
import { openAppDatabase } from '../openAppDatabase';

interface FixtureManifest {
  dbName: string;
  schemaVersion: number;
  lastPulledAt: string;
  sessionCount: number;
  pending: { editedSessionId: string; feedback: string; newSessionId: string; newSessionLinks: number };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Puts a WatermelonDB-generated file (synced, with unpushed local changes) exactly where
 * WatermelonDB's native adapter keeps it, opens it with Synclaire and syncs.
 */
export async function runInPlaceCheck(backend: Backend, log: (line: string) => void): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    results.push({ name, ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };

  const manifest = (await (await fetch(`${CONTROL_URL}/fixture/${backend.key}.json`)).json()) as FixtureManifest;
  const location = watermelonDatabaseLocation({
    platform: PLATFORM,
    dbName: manifest.dbName,
    documentDirectory: Paths.document.uri,
  });
  log(`placing fixture at ${location.directory}/${location.databaseName}`);

  const dir = new Directory(`file://${location.directory}`);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = new File(dir, `${location.databaseName}${suffix}`);
    if (f.exists) f.delete();
  }
  await File.downloadFileAsync(`${CONTROL_URL}/fixture/${backend.key}.db`, new File(dir, location.databaseName));

  const db = await openAppDatabase({
    code: backend.code,
    name: manifest.dbName,
    directory: location.directory,
  });
  try {
    check('opens without migrating', db.setup.action === 'none', `${db.setup.action} v${db.setup.fromVersion}->v${db.setup.toVersion}`);
    check(
      'keeps last pulled at',
      (await db.localStorage.get('__watermelon_last_pulled_at')) === manifest.lastPulledAt,
      manifest.lastPulledAt,
    );
    const sessions = await db.count('patient_sessions');
    check('reads all sessions', sessions === manifest.sessionCount, `${sessions}/${manifest.sessionCount}`);
    check('sees pending changes', await hasUnsyncedChanges({ database: db }));

    const created = await db.find('patient_sessions', manifest.pending.newSessionId);
    check('pending insert is created', created.syncStatus === 'created');
    const links = await db.count('patient_session_nurses', Q.where('session_id', manifest.pending.newSessionId));
    check('pending links present', links === manifest.pending.newSessionLinks, String(links));
    const edited = await db.find('patient_sessions', manifest.pending.editedSessionId);
    check('pending edit is updated', edited.syncStatus === 'updated' && edited.feedback === manifest.pending.feedback);

    const device = new Device(
      { baseUrl: apiUrl(backend), seed: backend.seed, openDatabase: async () => db, control: () => Promise.resolve('') },
      backend.seed.token,
    );
    device.db = db;
    const synced = await device.sync();
    check('syncs', synced.ok, synced.error);
    check('nothing pending after sync', !(await hasUnsyncedChanges({ database: db })));
    const lastPulledAt = Number(await db.localStorage.get('__watermelon_last_pulled_at'));
    check('last pulled at advanced', lastPulledAt > Number(manifest.lastPulledAt));
    const serverNew = await control(backend, 'readSession', manifest.pending.newSessionId);
    check('server has the pending insert', serverNew.startsWith('7|'), serverNew);
    const serverEdit = await control(backend, 'readSession', manifest.pending.editedSessionId);
    check('server has the pending edit', serverEdit.endsWith(`|${manifest.pending.feedback}`), serverEdit);
  } finally {
    await db.close();
  }
  return results;
}
