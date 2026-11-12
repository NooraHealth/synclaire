import { describe, expect, it, vi } from 'vitest';

import { DeletedRecordError, Q, RecordNotFoundError, TransactionFinishedError } from '../../src';
import type { BetterSqliteDriver } from '../../src/testing';
import { inSchema } from '../fixtures/countries';
import { clock, openTestDb } from '../helpers';

async function rawOf(driver: BetterSqliteDriver, table: string, id: string) {
  return driver.first<Record<string, unknown>>(`select * from "${table}" where id = ?`, [id]);
}

describe('insert', () => {
  it('creates a row with created status, empty _changed, and timestamps', async () => {
    const now = clock(1000, 1);
    const { db, driver } = await openTestDb(inSchema, { now });
    const row = await db.write(tx => tx.insert('patient_sessions', { class_type: 'cardio', no_of_patients: 3 }));
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(row)).toBe(true);
    expect(row).toMatchObject({
      syncStatus: 'created',
      class_type: 'cardio',
      no_of_patients: 3,
      created_at: 1001,
      updated_at: 1001,
      feedback: null,
      location: null,
      time_slot: '',
      date: 0,
    });
    const raw = await rawOf(driver, 'patient_sessions', row.id);
    expect(raw).toMatchObject({ _status: 'created', _changed: '' });
  });

  it('accepts an explicit id and explicit timestamps', async () => {
    const { db } = await openTestDb(inSchema, { now: () => 5 });
    const row = await db.write(tx => tx.insert('patient_sessions', { id: 'abc', created_at: 1, updated_at: 2 }));
    expect(row).toMatchObject({ id: 'abc', created_at: 1, updated_at: 2 });
  });

  it('does not stamp tables without timestamps', async () => {
    const { db } = await openTestDb(inSchema, { now: () => 5 });
    const row = await db.write(tx => tx.insert('nurses', { id: 'n' }));
    expect(row.privacy_consent_timestamp).toBeNull();
  });

  it('sanitizes wrong types like WatermelonDB', async () => {
    const { db } = await openTestDb(inSchema);
    const row = await db.write(tx =>
      tx.insert('patient_sessions', {
        no_of_patients: 'x' as unknown as number,
        feedback: 5 as unknown as string,
        date: Number.NaN,
      }),
    );
    expect(row).toMatchObject({ no_of_patients: 0, feedback: null, date: 0 });
  });

  it('rejects unknown columns', async () => {
    const { db } = await openTestDb(inSchema);
    await expect(
      db.write(tx => tx.insert('nurses', { bogus: 1 } as unknown as Record<string, never>)),
    ).rejects.toThrow(/Unknown column/);
  });
});

describe('update and _changed', () => {
  async function syncedSession() {
    const now = clock(10_000, 1);
    const t = await openTestDb(inSchema, { now });
    await t.db.write(tx => tx.insert('patient_sessions', { id: 's', feedback: 'a' }));
    await t.driver.run(`update patient_sessions set _status = 'synced', _changed = '' where id = 's'`);
    return t;
  }

  it('marks changed columns (plus updated_at) and sets updated status', async () => {
    const { db, driver } = await syncedSession();
    const row = await db.write(tx => tx.update('patient_sessions', 's', { feedback: 'b', no_of_patients: 2 }));
    expect(row.syncStatus).toBe('updated');
    expect(await rawOf(driver, 'patient_sessions', 's')).toMatchObject({
      _status: 'updated',
      _changed: 'updated_at,feedback,no_of_patients',
      feedback: 'b',
    });
  });

  it('does not mark unchanged values', async () => {
    const { db, driver } = await syncedSession();
    await db.write(tx => tx.update('patient_sessions', 's', { feedback: 'a' }));
    expect(await rawOf(driver, 'patient_sessions', 's')).toMatchObject({ _changed: 'updated_at' });
  });

  it('accumulates _changed without duplicates', async () => {
    const { db, driver } = await syncedSession();
    await db.write(tx => tx.update('patient_sessions', 's', { feedback: 'b' }));
    await db.write(tx => tx.update('patient_sessions', 's', { feedback: 'c', location: 'x' }));
    expect(await rawOf(driver, 'patient_sessions', 's')).toMatchObject({
      _changed: 'updated_at,feedback,location',
    });
  });

  it('keeps created status but records _changed', async () => {
    const { db, driver } = await openTestDb(inSchema, { now: clock() });
    await db.write(tx => tx.insert('patient_sessions', { id: 's' }));
    await db.write(tx => tx.update('patient_sessions', 's', { feedback: 'x' }));
    expect(await rawOf(driver, 'patient_sessions', 's')).toMatchObject({
      _status: 'created',
      _changed: 'updated_at,feedback',
    });
  });

  it('throws for missing and deleted records', async () => {
    const { db, driver } = await syncedSession();
    await expect(db.write(tx => tx.update('patient_sessions', 'nope', {}))).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    await driver.run(`update patient_sessions set _status = 'deleted' where id = 's'`);
    await expect(db.write(tx => tx.update('patient_sessions', 's', { feedback: 'z' }))).rejects.toBeInstanceOf(
      DeletedRecordError,
    );
    // Sessions stamp updated_at, so even an empty patch sets a column.
    await expect(db.write(tx => tx.update('patient_sessions', 's', {}))).rejects.toBeInstanceOf(DeletedRecordError);
  });

  it('treats an empty update of a deleted row without timestamps as a no-op, like WatermelonDB', async () => {
    const { db, driver } = await syncedSession();
    await db.write(tx => tx.insert('patient_session_nurses', { id: 'l', session_id: 's', nurse_id: 'n' }));
    await driver.run(`update patient_session_nurses set _status = 'deleted', _changed = '' where id = 'l'`);
    const row = await db.write(tx => tx.update('patient_session_nurses', 'l', {}));
    expect(row.syncStatus).toBe('deleted');
    await expect(db.write(tx => tx.update('patient_session_nurses', 'l', { nurse_id: 'm' }))).rejects.toBeInstanceOf(
      DeletedRecordError,
    );
  });
});

describe('markDeleted / destroyPermanently', () => {
  it('removes never-synced rows immediately by default', async () => {
    const { db, driver } = await openTestDb(inSchema);
    await db.write(tx => tx.insert('nurses', { id: 'n' }));
    await db.write(tx => tx.markDeleted('nurses', 'n'));
    expect(await rawOf(driver, 'nurses', 'n')).toBeNull();
  });

  it('keeps never-synced rows as deleted with deleteCreatedImmediately: false (Watermelon parity)', async () => {
    const { db, driver } = await openTestDb(inSchema, { deleteCreatedImmediately: false });
    await db.write(tx => tx.insert('nurses', { id: 'n' }));
    await db.write(tx => tx.markDeleted('nurses', 'n'));
    expect(await rawOf(driver, 'nurses', 'n')).toMatchObject({ _status: 'deleted' });
  });

  it('marks synced/updated rows as deleted, keeping _changed', async () => {
    const { db, driver } = await openTestDb(inSchema, { now: clock() });
    await db.write(tx => tx.insert('patient_sessions', { id: 's' }));
    await driver.run(`update patient_sessions set _status = 'synced' where id = 's'`);
    await db.write(tx => tx.update('patient_sessions', 's', { feedback: 'x' }));
    await db.write(tx => tx.markDeleted('patient_sessions', 's'));
    expect(await rawOf(driver, 'patient_sessions', 's')).toMatchObject({
      _status: 'deleted',
      _changed: 'updated_at,feedback',
    });
    // deleted rows are hidden from queries but returned by get (like Watermelon find)
    expect(await db.query('patient_sessions')).toHaveLength(0);
    expect((await db.get('patient_sessions', 's'))?.syncStatus).toBe('deleted');
    // marking again is a no-op
    await db.write(tx => tx.markDeleted('patient_sessions', 's'));
  });

  it('markDeletedWhere deletes all matches', async () => {
    const { db, driver } = await openTestDb(inSchema);
    await db.write(async tx => {
      await tx.insert('patient_session_nurses', { id: 'a', session_id: 's1' });
      await tx.insert('patient_session_nurses', { id: 'b', session_id: 's1' });
      await tx.insert('patient_session_nurses', { id: 'c', session_id: 's2' });
    });
    await driver.run(`update patient_session_nurses set _status = 'synced' where id = 'b'`);
    const n = await db.write(tx => tx.markDeletedWhere('patient_session_nurses', Q.where('session_id', 's1')));
    expect(n).toBe(2);
    expect(await rawOf(driver, 'patient_session_nurses', 'a')).toBeNull();
    expect(await rawOf(driver, 'patient_session_nurses', 'b')).toMatchObject({ _status: 'deleted' });
    expect(await db.count('patient_session_nurses')).toBe(1);
  });

  it('destroyPermanently removes rows regardless of status', async () => {
    const { db, driver } = await openTestDb(inSchema);
    await db.write(tx => tx.insert('nurses', { id: 'n' }));
    await driver.run(`update nurses set _status = 'deleted'`);
    await db.write(tx => tx.destroyPermanently('nurses', 'n'));
    expect(await rawOf(driver, 'nurses', 'n')).toBeNull();
    await db.write(async tx => {
      await tx.insert('nurses', { id: 'a', state: 'x' });
      await tx.insert('nurses', { id: 'b', state: 'x' });
    });
    expect(await db.write(tx => tx.destroyPermanentlyWhere('nurses', Q.where('state', 'x')))).toBe(2);
  });
});

describe('write transactions', () => {
  it('throws when the transaction handle is used after it finished (unawaited forEach bug)', async () => {
    const { db } = await openTestDb(inSchema);
    let escaped: Promise<unknown> | undefined;
    await db.write(async tx => {
      escaped = (async () => {
        await new Promise(r => setTimeout(r, 5));
        return tx.insert('nurses', { id: 'late' });
      })();
    });
    await expect(escaped).rejects.toBeInstanceOf(TransactionFinishedError);
    expect(await db.get('nurses', 'late')).toBeNull();
  });

  it('rolls back everything on error', async () => {
    const { db } = await openTestDb(inSchema);
    await expect(
      db.write(async tx => {
        await tx.insert('nurses', { id: 'a' });
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(await db.get('nurses', 'a')).toBeNull();
  });

  it('serialises writers', async () => {
    const { db } = await openTestDb(inSchema);
    await db.write(tx => tx.insert('nurses', { id: 'n', date_of_tot: 0 }));
    const inc = () =>
      db.write(async tx => {
        const n = await tx.find('nurses', 'n');
        await new Promise(r => setTimeout(r, 1));
        await tx.update('nurses', 'n', { date_of_tot: Number(n.date_of_tot) + 1 });
      });
    await Promise.all(Array.from({ length: 25 }, inc));
    expect((await db.find('nurses', 'n')).date_of_tot).toBe(25);
  });

  it('emits one change event per commit with touched tables, none on rollback or no-op', async () => {
    const { db } = await openTestDb(inSchema);
    const events: string[][] = [];
    const off = db.onChange(t => events.push([...t].sort()));
    await db.write(async tx => {
      await tx.insert('nurses', { id: 'a' });
      await tx.insert('nurses', { id: 'b' });
      await tx.insert('patient_sessions', { id: 's' });
    });
    await db.write(async tx => {
      await tx.query('nurses');
    });
    await db.write(async () => {
      throw new Error('x');
    }).catch(() => null);
    off();
    await db.write(tx => tx.insert('nurses', { id: 'c' }));
    expect(events).toEqual([['nurses', 'patient_sessions']]);
  });

  it('isolates listener errors', async () => {
    const { db } = await openTestDb(inSchema);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = vi.fn();
    db.onChange(() => {
      throw new Error('bad listener');
    });
    db.onChange(good);
    await db.write(tx => tx.insert('nurses', { id: 'a' }));
    expect(good).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('read() gives a consistent snapshot', async () => {
    const { db } = await openTestDb(inSchema);
    await db.write(tx => tx.insert('nurses', { id: 'a' }));
    const result = await db.read(async tx => [await tx.count('nurses'), (await tx.query('nurses')).length]);
    expect(result).toEqual([1, 1]);
  });
});

describe('localStorage and reset', () => {
  it('stores raw strings in local_storage', async () => {
    const { db, driver } = await openTestDb(inSchema);
    expect(await db.localStorage.get('k')).toBeNull();
    await db.localStorage.set('k', 'v');
    await db.localStorage.set('k', 'v2');
    expect(await db.localStorage.get('k')).toBe('v2');
    expect(await driver.all('select * from local_storage')).toEqual([{ key: 'k', value: 'v2' }]);
    await db.localStorage.remove('k');
    expect(await db.localStorage.get('k')).toBeNull();
    await expect(db.localStorage.set('k', 1 as unknown as string)).rejects.toThrow(/strings/);
  });

  it('reset() wipes data and local storage, recreates schema and bumps resetCount', async () => {
    const { db } = await openTestDb(inSchema);
    await db.write(tx => tx.insert('nurses', { id: 'a' }));
    await db.localStorage.set('__watermelon_last_pulled_at', '123');
    const events: string[][] = [];
    db.onChange(t => events.push([...t].sort()));
    await db.reset();
    expect(db.resetCount).toBe(1);
    expect(await db.count('nurses')).toBe(0);
    expect(await db.localStorage.get('__watermelon_last_pulled_at')).toBeNull();
    expect(events).toEqual([['nurses', 'patient_session_nurses', 'patient_sessions']]);
    await db.write(tx => tx.insert('nurses', { id: 'b' }));
    expect(await db.count('nurses')).toBe(1);
  });
});
