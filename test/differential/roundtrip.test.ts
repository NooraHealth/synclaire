import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, Q, synchronize, type Schema } from '../../src';
import { BetterSqliteDriver } from '../../src/testing';
import {
  COUNTRIES,
  synclaireMigrations,
  synclaireSchema,
  watermelonModels,
  watermelonSchemaV1,
  type CountryCode,
} from '../fixtures/countries';
import { dumpFile, tmpDbPath } from '../helpers';

import { FakeClock, WatermelonClient } from './harness';
import { ModelServer } from './modelServer';

const require = createRequire(import.meta.url);
const wm = require('@nozbe/watermelondb') as any;
const SQLiteAdapter = require('@nozbe/watermelondb/adapters/sqlite').default as any;

const quiet = { warn: () => undefined, error: () => undefined };
const clock = new FakeClock();

async function openSynclaire(code: CountryCode, path: string) {
  return openDatabase({
    driver: new BetterSqliteDriver({ path }),
    schema: synclaireSchema(code) as Schema,
    migrations: synclaireMigrations(code),
    now: () => Date.now(),
  });
}

function seedServer() {
  const server = new ModelServer();
  server.upsert('nurses', 'me', { name: 'Me' });
  server.upsert('nurses', 'col', { name: 'Colleague' });
  for (const id of ['s1', 's2', 's3']) {
    server.upsert('patient_sessions', id, { created_by: 'me', date: 1, feedback: null });
    server.upsert('patient_session_nurses', `l-${id}`, { session_id: id, nurse_id: 'me' });
  }
  return server;
}

describe.each(COUNTRIES)('file round trip Watermelon -> Synclaire -> Watermelon (%s)', code => {
  beforeAll(() => clock.install());
  afterAll(() => clock.uninstall());

  it('keeps data, pending changes and sync state across libraries', async () => {
    const server = seedServer();
    const file = tmpDbPath(`rt-${code}`);

    // 1. Watermelon creates and syncs the file, then leaves local changes pending.
    const w1 = new WatermelonClient(code, file);
    expect((await w1.sync(server)).ok).toBe(true);
    clock.advance();
    await w1.update('patient_sessions', 's1', { feedback: 'pending from watermelon' });
    await w1.markDeleted('patient_sessions', 's2');
    await w1.insert('patient_sessions', { id: 's-wm', created_by: 'me', date: 2 });
    const afterWm = dumpFile(file);

    // 2. Synclaire opens the same file in place: no migration, no reset, same rows.
    clock.advance();
    const sc = await openSynclaire(code, file);
    expect(sc.setup.action).toBe('none');
    expect(await sc.localStorage.get('__watermelon_last_pulled_at')).toBe(
      afterWm.local_storage.find(l => l.key === '__watermelon_last_pulled_at')!.value,
    );
    expect((await sc.get('patient_sessions', 's1'))).toMatchObject({ feedback: 'pending from watermelon', syncStatus: 'updated' });
    expect((await sc.get('patient_sessions', 's2'))?.syncStatus).toBe('deleted');
    expect((await sc.get('patient_sessions', 's-wm'))?.syncStatus).toBe('created');
    expect((await sc.query('patient_sessions', Q.on('patient_session_nurses', 'nurse_id', 'me'))).map(r => r.id).sort()).toEqual([
      's1',
      's3',
    ]);

    // Synclaire writes and syncs, pushing Watermelon's pending changes too.
    await sc.write(async tx => {
      await tx.update('patient_sessions', 's3', { feedback: 'from synclaire' });
      await tx.insert('patient_sessions', { id: 's-sc', created_by: 'me', date: 3 });
      await tx.insert('patient_session_nurses', { id: 'l-sc', session_id: 's-sc', nurse_id: 'me' });
    });
    server.upsert('nurses', 'col', { name: 'Colleague renamed' });
    let pushed: any;
    await synchronize({
      database: sc,
      sendCreatedAsUpdated: true,
      logger: quiet,
      pullChanges: ({ lastPulledAt }) => server.pull(lastPulledAt) as never,
      pushChanges: async ({ changes, lastPulledAt }) => {
        pushed = JSON.parse(JSON.stringify(changes));
        await server.push(changes, lastPulledAt);
      },
    });
    expect(pushed.patient_sessions.created.map((r: any) => r.id).sort()).toEqual(['s-sc', 's-wm']);
    expect(pushed.patient_sessions.updated.map((r: any) => r.id).sort()).toEqual(['s1', 's3']);
    expect(pushed.patient_sessions.deleted).toEqual(['s2']);
    await sc.close();

    // 3. Watermelon reopens the file and sees a consistent, fully synced state.
    clock.advance();
    const w2 = new WatermelonClient(code, file);
    expect(await w2.hasUnsyncedChanges()).toBe(false);
    const sessions = await w2.db.get('patient_sessions').query().fetch();
    expect(sessions.map((s: any) => s.id).sort()).toEqual(['s-sc', 's-wm', 's1', 's3']);
    const s3 = await w2.db.get('patient_sessions').find('s3');
    expect(s3._raw).toMatchObject({ feedback: 'from synclaire', _status: 'synced', _changed: '' });
    expect((await w2.db.get('nurses').find('col'))._raw.name).toBe('Colleague renamed');
    const joined = await w2.db
      .get('patient_sessions')
      .query(wm.Q.on('patient_session_nurses', 'nurse_id', 'me'))
      .fetch();
    expect(joined.map((s: any) => s.id).sort()).toEqual(['s-sc', 's1', 's3']);

    // ...and can keep syncing incrementally from where Synclaire left off.
    await w2.update('patient_sessions', 's1', { feedback: 'back in watermelon' });
    const again = await w2.sync(server);
    expect(again.ok).toBe(true);
    expect((again.pushed[0] as any).patient_sessions.updated.map((r: any) => r.id)).toEqual(['s1']);
  });

  it('Synclaire migrates an old Watermelon file in place and Watermelon opens the result', async () => {
    const file = tmpDbPath(`rt-mig-${code}`);
    const old = new wm.Database({
      adapter: new SQLiteAdapter({ dbName: file, schema: watermelonSchemaV1(code) }),
      modelClasses: watermelonModels(),
    });
    await old.write(() =>
      old.get('nurses').create((r: any) => {
        r._raw.id = 'n-old';
        r._setRaw('name', 'Old');
      }),
    );
    expect(dumpFile(file).user_version).toBe(1);

    const sc = await openSynclaire(code, file);
    expect(sc.setup).toMatchObject({ action: 'migrated', fromVersion: 1 });
    expect((await sc.find('nurses', 'n-old')).name).toBe('Old');
    await sc.close();

    const w = new WatermelonClient(code, file);
    const nurse = await w.db.get('nurses').find('n-old');
    expect(nurse._raw).toMatchObject({ name: 'Old', _status: 'created', privacy_consent_timestamp: 0 });
  });

  it('Watermelon opens a file Synclaire created', async () => {
    const file = tmpDbPath(`rt-sc-${code}`);
    const sc = await openSynclaire(code, file);
    await sc.write(tx => tx.insert('nurses', { id: 'n1', name: 'From Synclaire' }));
    await sc.close();
    const w = new WatermelonClient(code, file);
    expect((await w.db.get('nurses').find('n1'))._raw).toMatchObject({ name: 'From Synclaire', _status: 'created' });
    expect(await w.hasUnsyncedChanges()).toBe(true);
  });
});
