import fs from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';

import type { Driver, RunResult, SqlExecutor, SqlRow, SqlValue } from '../driver/types';
import { Mutex } from '../utils/Mutex';

type Params = readonly SqlValue[];

function bind(params?: Params): unknown[] {
  return params ? (params as unknown[]) : [];
}

const STATEMENT_CACHE_SIZE = 256;

function executorFor(db: BetterSqlite3.Database): SqlExecutor {
  const cache = new Map<string, BetterSqlite3.Statement>();
  const prepare = (sql: string) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      if (cache.size >= STATEMENT_CACHE_SIZE) cache.delete(cache.keys().next().value!);
      cache.set(sql, stmt);
    }
    return stmt;
  };
  return {
    async exec(sql: string) {
      // DDL can invalidate cached statements (e.g. after a reset drops tables).
      cache.clear();
      db.exec(sql);
    },
    async run(sql: string, params?: Params): Promise<RunResult> {
      const info = prepare(sql).run(...bind(params));
      return { changes: info.changes };
    },
    async all<T = SqlRow>(sql: string, params?: Params): Promise<T[]> {
      const stmt = prepare(sql);
      return (stmt.reader ? stmt.all(...bind(params)) : (stmt.run(...bind(params)), [])) as T[];
    },
    async first<T = SqlRow>(sql: string, params?: Params): Promise<T | null> {
      const stmt = prepare(sql);
      if (!stmt.reader) {
        stmt.run(...bind(params));
        return null;
      }
      return (stmt.get(...bind(params)) as T | undefined) ?? null;
    },
  };
}

export interface BetterSqliteDriverOptions {
  /** File path, or `:memory:`. */
  path: string;
  readonly?: boolean;
}

/** Node driver on better-sqlite3, used by tests, benchmarks and the differential harness. */
export class BetterSqliteDriver implements Driver {
  readonly name: string;

  private db: BetterSqlite3.Database;

  private executor: SqlExecutor;

  private txMutex = new Mutex();

  constructor(options: BetterSqliteDriverOptions) {
    this.name = options.path;
    this.db = new BetterSqlite3(options.path, { readonly: options.readonly ?? false });
    this.executor = executorFor(this.db);
  }

  exec(sql: string) {
    return this.executor.exec(sql);
  }

  run(sql: string, params?: Params) {
    return this.executor.run(sql, params);
  }

  all<T = SqlRow>(sql: string, params?: Params) {
    return this.executor.all<T>(sql, params);
  }

  first<T = SqlRow>(sql: string, params?: Params) {
    return this.executor.first<T>(sql, params);
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.txMutex.runExclusive(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.executor);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async close() {
    if (this.db.open) this.db.close();
  }

  async deleteDatabase() {
    await this.close();
    if (this.name === ':memory:') return;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      fs.rmSync(`${this.name}${suffix}`, { force: true });
    }
  }
}
