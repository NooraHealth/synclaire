import fs from 'node:fs';

import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { openExpoSqliteDriver, watermelonDatabaseLocation } from '../../src/expo';
import type { ExpoSQLiteDatabaseLike, ExpoSQLiteExecutorLike, ExpoSQLiteModuleLike } from '../../src/expo/expoTypes';
import { BetterSqliteDriver } from '../../src/testing';
import { tmpDbPath } from '../helpers';

describe('BetterSqliteDriver', () => {
  it('runs statements and commits transactions', async () => {
    const d = new BetterSqliteDriver({ path: ':memory:' });
    await d.exec('create table t (id primary key, v)');
    await d.run('insert into t values (?, ?)', ['a', 1]);
    await d.transaction(async tx => {
      await tx.run('insert into t values (?, ?)', ['b', 2]);
    });
    expect(await d.all('select * from t order by id')).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
    expect(await d.first('select * from t where id = ?', ['zz'])).toBeNull();
    await d.close();
  });

  it('rolls back on error', async () => {
    const d = new BetterSqliteDriver({ path: ':memory:' });
    await d.exec('create table t (id primary key)');
    await expect(
      d.transaction(async tx => {
        await tx.run('insert into t values (?)', ['a']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await d.all('select * from t')).toEqual([]);
  });

  it('serialises concurrent transactions', async () => {
    const d = new BetterSqliteDriver({ path: ':memory:' });
    await d.exec('create table t (n)');
    await d.run('insert into t values (0)');
    const inc = () =>
      d.transaction(async tx => {
        const row = await tx.first<{ n: number }>('select n from t');
        await new Promise(r => setTimeout(r, 1));
        await tx.run('update t set n = ?', [row!.n + 1]);
      });
    await Promise.all(Array.from({ length: 20 }, inc));
    expect(await d.first('select n from t')).toEqual({ n: 20 });
  });

  it('deleteDatabase removes the file', async () => {
    const file = tmpDbPath();
    const d = new BetterSqliteDriver({ path: file });
    await d.exec('create table t (x)');
    expect(fs.existsSync(file)).toBe(true);
    await d.deleteDatabase();
    expect(fs.existsSync(file)).toBe(false);
  });
});

/** A fake expo-sqlite module backed by better-sqlite3, with a separate connection per exclusive transaction. */
function fakeExpoModule(dir: string) {
  const calls: string[] = [];
  const executor = (db: BetterSqlite3.Database): ExpoSQLiteExecutorLike => ({
    async execAsync(sql) {
      calls.push(`exec:${sql}`);
      db.exec(sql);
    },
    async runAsync(sql, params) {
      const r = db.prepare(sql).run(...(params as unknown[]));
      return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    async getFirstAsync<T>(sql: string, params: unknown[]) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
  });
  const mod: ExpoSQLiteModuleLike = {
    async openDatabaseAsync(name, _options, directory) {
      const file = `${directory ?? dir}/${name}`;
      calls.push(`open:${file}`);
      const db = new BetterSqlite3(file);
      const self: ExpoSQLiteDatabaseLike = {
        ...executor(db),
        databasePath: file,
        async withExclusiveTransactionAsync(task) {
          const conn = new BetterSqlite3(file);
          conn.pragma('busy_timeout = 5000');
          conn.exec('BEGIN EXCLUSIVE');
          try {
            await task(executor(conn));
            conn.exec('COMMIT');
          } catch (e) {
            conn.exec('ROLLBACK');
            throw e;
          } finally {
            conn.close();
          }
        },
        async closeAsync() {
          db.close();
        },
      };
      return self;
    },
    async deleteDatabaseAsync(name, directory) {
      fs.rmSync(`${directory ?? dir}/${name}`, { force: true });
    },
  };
  return { mod, calls };
}

describe('ExpoSqliteDriver', () => {
  it('opens with WAL, caches connections, and commits via exclusive transactions', async () => {
    const dir = fs.mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/expo-`);
    const { mod, calls } = fakeExpoModule(dir);
    const d1 = await openExpoSqliteDriver({ databaseName: 'a.db', directory: `file://${dir}`, sqliteModule: mod });
    const d2 = await openExpoSqliteDriver({ databaseName: 'a.db', directory: dir, sqliteModule: mod });
    expect(d1).toBe(d2);
    expect(calls.filter(c => c.startsWith('open:'))).toEqual([`open:${dir}/a.db`]);
    expect(calls).toContain('exec:PRAGMA journal_mode = wal');
    expect(await d1.first<{ journal_mode: string }>('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });

    await d1.exec('create table t (id primary key, v)');
    const result = await d1.transaction(async tx => {
      await tx.run('insert into t values (?, ?)', ['a', 1]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(await d1.all('select * from t')).toEqual([{ id: 'a', v: 1 }]);

    await expect(
      d1.transaction(async tx => {
        await tx.run('insert into t values (?, ?)', ['b', 2]);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await d1.all('select id from t')).toEqual([{ id: 'a' }]);

    await d1.deleteDatabase();
    expect(fs.existsSync(`${dir}/a.db`)).toBe(false);
    const d3 = await openExpoSqliteDriver({ databaseName: 'a.db', directory: dir, sqliteModule: mod, journalMode: 'keep' });
    expect(d3).not.toBe(d1);
    expect(calls.filter(c => c === 'exec:PRAGMA journal_mode = wal')).toHaveLength(1);
    await d3.close();
  });
});

describe('watermelonDatabaseLocation', () => {
  it('iOS uses the Documents directory', () => {
    expect(
      watermelonDatabaseLocation({
        platform: 'ios',
        dbName: 'in_42',
        documentDirectory: 'file:///var/mobile/Containers/Data/Application/ABC/Documents/',
      }),
    ).toEqual({ directory: '/var/mobile/Containers/Data/Application/ABC/Documents', databaseName: 'in_42.db' });
  });

  it('Android uses the app data root (parent of files/)', () => {
    expect(
      watermelonDatabaseLocation({
        platform: 'android',
        dbName: 'in_42',
        documentDirectory: 'file:///data/user/0/com.example.app/files/',
      }),
    ).toEqual({ directory: '/data/user/0/com.example.app', databaseName: 'in_42.db' });
  });
});
