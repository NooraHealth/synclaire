import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import BetterSqlite3 from 'better-sqlite3';

import { openDatabase, type Database, type Migrations, type OpenDatabaseOptions, type Schema } from '../src';
import { BetterSqliteDriver } from '../src/testing';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let counter = 0;

export function tmpDir(prefix = 'synclaire-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function tmpDbPath(name = 'test'): string {
  counter += 1;
  return path.join(tmpDir(), `${name}-${process.pid}-${counter}.db`);
}

export async function openTestDb<S extends Schema>(
  schema: S,
  options: Partial<Omit<OpenDatabaseOptions<S>, 'schema' | 'driver'>> & { path?: string; migrations?: Migrations } = {},
): Promise<{ db: Database<S>; driver: BetterSqliteDriver; path: string }> {
  const file = options.path ?? tmpDbPath();
  const driver = new BetterSqliteDriver({ path: file });
  const db = await openDatabase({ ...options, schema, driver });
  return { db, driver, path: file };
}

export interface DbDump {
  user_version: number;
  ddl: { type: string; name: string; sql: string }[];
  local_storage: { key: string; value: string }[];
  rows: Record<string, Record<string, unknown>[]>;
}

/** Dumps a database file the same way `.sync-probe/probe.js` did. */
export function dumpFile(file: string, tables?: string[]): DbDump {
  const s = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
  try {
    const ddl = s
      .prepare("select type, name, sql from sqlite_master where sql is not null order by type, name")
      .all() as DbDump['ddl'];
    const tableNames =
      tables ?? ddl.filter(d => d.type === 'table' && d.name !== 'local_storage').map(d => d.name);
    const rows: DbDump['rows'] = {};
    for (const t of tableNames) {
      rows[t] = s.prepare(`select * from "${t}" order by "id"`).all() as Record<string, unknown>[];
    }
    return {
      user_version: s.pragma('user_version', { simple: true }) as number,
      ddl,
      local_storage: s.prepare('select * from local_storage order by key').all() as DbDump['local_storage'],
      rows,
    };
  } finally {
    s.close();
  }
}

export function readFixture<T = unknown>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'probe', name), 'utf8')) as T;
}

export function clock(start = 1_700_000_000_000, step = 1000): () => number {
  let t = start;
  return () => {
    t += step;
    return t;
  };
}
