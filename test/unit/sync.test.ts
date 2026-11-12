import { describe, expect, it, vi } from 'vitest';

import {
  ConcurrentSyncError,
  hasUnsyncedChanges,
  InvalidPullError,
  SyncAlreadyRunningError,
  SyncDatabaseResetError,
  synchronize,
  SyncLogger,
  type SyncConflict,
  type SyncLog,
  type SyncPushArgs,
} from '../../src';
import { inSchema } from '../fixtures/countries';
import { clock, openTestDb } from '../helpers';

const quiet = { warn: vi.fn(), error: vi.fn() };
const empty = () => ({ patient_sessions: { created: [], updated: [], deleted: [] } });

function session(id: string, extra: Record<string, unknown> = {}) {
  return { id, date: 1, class_type: 'c', created_by: 'n1', feedback: null, ...extra };
}

async function rows(driver: { all: (sql: string) => Promise<unknown[]> }, table: string) {
  return driver.all(`select id, _status, _changed, feedback, no_of_patients from "${table}" order by id`);
}

describe('synchronize: pull', () => {
  it('first sync inserts synced rows, skips unknown tables and columns, saves timestamp and schema version', async () => {
    const { db, driver } = await openTestDb(inSchema);
    const pull = vi.fn(async () => ({
      changes: {
        patient_sessions: { created: [], updated: [session('s1', { extra_col: 1, feedback: 'f' })], deleted: [] },
        patients: { created: [], updated: [{ id: 'p1' }], deleted: [] },
      },
      timestamp: 1000,
    }));
    await synchronize({ database: db, pullChanges: pull, sendCreatedAsUpdated: true, logger: quiet });
    expect(pull).toHaveBeenCalledWith({ lastPulledAt: null, schemaVersion: 3, migration: null });
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('patients'));
    expect(await rows(driver, 'patient_sessions')).toEqual([
      { id: 's1', _status: 'synced', _changed: '', feedback: 'f', no_of_patients: 0 },
    ]);
    expect(await db.localStorage.get('__watermelon_last_pulled_at')).toBe('1000');
    expect(await db.localStorage.get('__watermelon_last_pulled_schema_version')).toBe('3');

    await db.localStorage.set('__watermelon_last_pulled_schema_version', '2');
    await synchronize({ database: db, pullChanges: async () => ({ changes: empty(), timestamp: 2000 }), logger: quiet });
    expect(await db.localStorage.get('__watermelon_last_pulled_schema_version')).toBe('2');
    expect(await db.localStorage.get('__watermelon_last_pulled_at')).toBe('2000');
  });

  it('merges per column: remote values, then locally changed columns on top', async () => {
    const { db, driver } = await openTestDb(inSchema, { now: clock() });
    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: { patient_sessions: { created: [session('s1')], updated: [], deleted: [] } },
        timestamp: 1,
      }),
      logger: quiet,
    });
    await db.write(tx => tx.update('patient_sessions', 's1', { feedback: 'local' }));
    const log: SyncLog = {};
    const conflicts: SyncConflict[] = [];
    await synchronize({
      database: db,
      log,
      onConflict: c => conflicts.push(c),
      pullChanges: async () => ({
        changes: {
          patient_sessions: { created: [], updated: [session('s1', { feedback: 'remote', no_of_patients: 7 })], deleted: [] },
        },
        timestamp: 2,
      }),
      logger: quiet,
    });
    expect(await rows(driver, 'patient_sessions')).toEqual([
      { id: 's1', _status: 'updated', _changed: 'updated_at,feedback', feedback: 'local', no_of_patients: 7 },
    ]);
    expect(log.resolvedConflicts).toHaveLength(1);
    expect(conflicts[0]?.type).toBe('merge');
  });

  it('remote delete destroys a locally edited row and reports it', async () => {
    const { db, driver } = await openTestDb(inSchema, { now: clock() });
    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: { patient_sessions: { created: [session('s1'), session('s2')], updated: [], deleted: [] } },
        timestamp: 1,
      }),
      logger: quiet,
    });
    await db.write(tx => tx.update('patient_sessions', 's1', { feedback: 'edit' }));
    const conflicts: SyncConflict[] = [];
    await synchronize({
      database: db,
      onConflict: c => conflicts.push(c),
      pullChanges: async () => ({
        changes: { patient_sessions: { created: [], updated: [], deleted: ['s1', 's2', 'unknown'] } },
        timestamp: 2,
      }),
      logger: quiet,
    });
    expect(await rows(driver, 'patient_sessions')).toEqual([]);
    expect(conflicts.map(c => c.type)).toEqual(['remoteDelete']);
  });

  it('keeps a local deletion when the server updates the row', async () => {
    const { db, driver } = await openTestDb(inSchema);
    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: { patient_sessions: { created: [session('s1')], updated: [], deleted: [] } },
        timestamp: 1,
      }),
      logger: quiet,
    });
    await db.write(tx => tx.markDeleted('patient_sessions', 's1'));
    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: { patient_sessions: { created: [], updated: [session('s1', { feedback: 'r' })], deleted: [] } },
        timestamp: 2,
      }),
      logger: quiet,
    });
    expect(await rows(driver, 'patient_sessions')).toEqual([
      { id: 's1', _status: 'deleted', _changed: '', feedback: null, no_of_patients: 0 },
    ]);
  });

  it.each([
    ['missing timestamp', { changes: {}, timestamp: 0 }],
    ['record with _status', { changes: { nurses: { created: [], updated: [{ id: 'x', _status: 'synced' }], deleted: [] } }, timestamp: 1 }],
    ['record without id', { changes: { nurses: { created: [{ name: 'x' }], updated: [], deleted: [] } }, timestamp: 1 }],
    ['non-array', { changes: { nurses: { created: {}, updated: [], deleted: [] } }, timestamp: 1 }],
  ])('rejects an invalid pull (%s) without writing anything', async (_label, result) => {
    const { db } = await openTestDb(inSchema);
    await expect(
      synchronize({ database: db, pullChanges: async () => result as never, logger: quiet }),
    ).rejects.toBeInstanceOf(InvalidPullError);
    expect(await db.localStorage.get('__watermelon_last_pulled_at')).toBeNull();
  });
});

describe('synchronize: push', () => {
  async function syncedDb() {
    const t = await openTestDb(inSchema, { now: clock() });
    await synchronize({
      database: t.db,
      pullChanges: async () => ({
        changes: { patient_sessions: { created: [session('s1'), session('s2')], updated: [], deleted: [] } },
        timestamp: 100,
      }),
      logger: quiet,
    });
    return t;
  }

  it('pushes full raw rows for every schema table and marks them synced', async () => {
    const { db, driver } = await syncedDb();
    await db.write(async tx => {
      await tx.insert('nurses', { id: 'n-new', name: 'New' });
      await tx.update('patient_sessions', 's1', { feedback: 'x' });
      await tx.markDeleted('patient_sessions', 's2');
    });
    expect(await hasUnsyncedChanges({ database: db })).toBe(true);
    let pushed: SyncPushArgs | undefined;
    await synchronize({
      database: db,
      pullChanges: async () => ({ changes: {}, timestamp: 200 }),
      pushChanges: async args => {
        pushed = structuredClone(args);
      },
      logger: quiet,
    });
    expect(pushed!.lastPulledAt).toBe(200);
    expect(Object.keys(pushed!.changes)).toEqual(['patient_sessions', 'nurses', 'patient_session_nurses']);
    expect(pushed!.changes.patient_session_nurses).toEqual({ created: [], updated: [], deleted: [] });
    expect(pushed!.changes.patient_sessions!.deleted).toEqual(['s2']);
    const updated = pushed!.changes.patient_sessions!.updated[0]!;
    expect(Object.keys(updated).slice(0, 4)).toEqual(['id', '_status', '_changed', 'date']);
    expect(updated).toMatchObject({ id: 's1', _status: 'updated', _changed: 'updated_at,feedback', feedback: 'x' });
    expect(pushed!.changes.nurses!.created[0]).toMatchObject({ id: 'n-new', _status: 'created', _changed: '' });
    expect(await hasUnsyncedChanges({ database: db })).toBe(false);
    expect(await rows(driver, 'patient_sessions')).toEqual([
      { id: 's1', _status: 'synced', _changed: '', feedback: 'x', no_of_patients: 0 },
    ]);
  });

  it('leaves everything pending when push fails', async () => {
    const { db } = await syncedDb();
    await db.write(tx => tx.update('patient_sessions', 's1', { feedback: 'x' }));
    await expect(
      synchronize({
        database: db,
        pullChanges: async () => ({ changes: {}, timestamp: 200 }),
        pushChanges: async () => {
          throw new Error('400');
        },
        logger: quiet,
      }),
    ).rejects.toThrow('400');
    expect((await db.find('patient_sessions', 's1')).syncStatus).toBe('updated');
    expect(await db.localStorage.get('__watermelon_last_pulled_at')).toBe('200');
  });

  it('keeps rows edited during the push pending', async () => {
    const { db } = await syncedDb();
    await db.write(tx => tx.update('patient_sessions', 's1', { feedback: 'x' }));
    await synchronize({
      database: db,
      pullChanges: async () => ({ changes: {}, timestamp: 200 }),
      pushChanges: async () => {
        await db.write(tx => tx.update('patient_sessions', 's1', { feedback: 'during push' }));
      },
      logger: quiet,
    });
    expect((await db.find('patient_sessions', 's1')).syncStatus).toBe('updated');
  });

  it('honours experimentalRejectedIds', async () => {
    const { db } = await syncedDb();
    await db.write(async tx => {
      await tx.update('patient_sessions', 's1', { feedback: 'x' });
      await tx.update('patient_sessions', 's2', { feedback: 'y' });
    });
    await synchronize({
      database: db,
      pullChanges: async () => ({ changes: {}, timestamp: 200 }),
      pushChanges: async () => ({ experimentalRejectedIds: { patient_sessions: ['s2'] } }),
      logger: quiet,
    });
    expect((await db.find('patient_sessions', 's1')).syncStatus).toBe('synced');
    expect((await db.find('patient_sessions', 's2')).syncStatus).toBe('updated');
  });

  it('does not call pushChanges when nothing changed', async () => {
    const { db } = await syncedDb();
    const push = vi.fn();
    await synchronize({ database: db, pullChanges: async () => ({ changes: {}, timestamp: 300 }), pushChanges: push, logger: quiet });
    expect(push).not.toHaveBeenCalled();
  });

  it('applies the echo of its own push as a no-op replacement', async () => {
    const { db, driver } = await syncedDb();
    await db.write(tx => tx.update('patient_sessions', 's1', { feedback: 'x' }));
    let echoed: Record<string, unknown> | undefined;
    await synchronize({
      database: db,
      pullChanges: async () => ({ changes: {}, timestamp: 200 }),
      pushChanges: async ({ changes }) => {
        const { _status, _changed, ...rest } = changes.patient_sessions!.updated[0]!;
        void _status;
        void _changed;
        echoed = rest;
      },
      logger: quiet,
    });
    const before = await rows(driver, 'patient_sessions');
    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: { patient_sessions: { created: [], updated: [echoed!], deleted: [] } },
        timestamp: 300,
      }),
      logger: quiet,
    });
    expect(await rows(driver, 'patient_sessions')).toEqual(before);
  });
});

describe('synchronize: guards and logs', () => {
  it('throws when a second sync starts while one is running', async () => {
    const { db } = await openTestDb(inSchema);
    let release!: () => void;
    let pulling!: () => void;
    const pullStarted = new Promise<void>(r => (pulling = r));
    const first = synchronize({
      database: db,
      pullChanges: () =>
        new Promise(r => {
          release = () => r({ changes: {}, timestamp: 1 });
          pulling();
        }),
      logger: quiet,
    });
    await pullStarted;
    await expect(
      synchronize({ database: db, pullChanges: async () => ({ changes: {}, timestamp: 1 }), logger: quiet }),
    ).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    release();
    await first;
  });

  it('aborts if lastPulledAt changed under it (Watermelon concurrency check)', async () => {
    const { db } = await openTestDb(inSchema);
    await expect(
      synchronize({
        database: db,
        pullChanges: async () => {
          await db.localStorage.set('__watermelon_last_pulled_at', '5');
          return { changes: {}, timestamp: 10 };
        },
        logger: quiet,
      }),
    ).rejects.toBeInstanceOf(ConcurrentSyncError);
  });

  it('aborts if the database was reset during the sync', async () => {
    const { db } = await openTestDb(inSchema);
    await expect(
      synchronize({
        database: db,
        pullChanges: async () => {
          await db.reset();
          return { changes: {}, timestamp: 10 };
        },
        logger: quiet,
      }),
    ).rejects.toBeInstanceOf(SyncDatabaseResetError);
    expect(await db.localStorage.get('__watermelon_last_pulled_at')).toBeNull();
  });

  it('fills the SyncLog like Watermelon and SyncLogger keeps recent logs', async () => {
    const { db } = await openTestDb(inSchema);
    const logger = new SyncLogger(2);
    const log = logger.newLog();
    await synchronize({ database: db, log, pullChanges: async () => ({ changes: empty(), timestamp: 10 }), logger: quiet });
    expect(log).toMatchObject({
      lastPulledAt: null,
      newLastPulledAt: 10,
      remoteChangeCount: 0,
      phase: 'done',
    });
    expect(log.startedAt).toBeInstanceOf(Date);
    logger.newLog();
    logger.newLog();
    expect(logger.logs).toHaveLength(2);
    expect(logger.logs[0]).not.toBe(log);
  });

  it('emits change events for tables changed by sync', async () => {
    const { db } = await openTestDb(inSchema);
    const events: string[][] = [];
    db.onChange(t => events.push([...t]));
    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: { nurses: { created: [], updated: [{ id: 'n1' }], deleted: [] } },
        timestamp: 10,
      }),
      sendCreatedAsUpdated: true,
      logger: quiet,
    });
    expect(events).toEqual([['nurses']]);
  });
});
