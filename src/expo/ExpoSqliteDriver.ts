import type { Driver, RunResult, SqlExecutor, SqlRow, SqlValue } from '../driver/types';
import { Mutex } from '../utils/Mutex';

import type {
  ExpoBindValue,
  ExpoSQLiteDatabaseLike,
  ExpoSQLiteExecutorLike,
  ExpoSQLiteModuleLike,
} from './expoTypes';

type Params = readonly SqlValue[];

function wrap(target: ExpoSQLiteExecutorLike): SqlExecutor {
  const p = (params?: Params) => (params ? [...params] : []) as ExpoBindValue[];
  return {
    exec: sql => target.execAsync(sql),
    run: async (sql, params): Promise<RunResult> => {
      const r = await target.runAsync(sql, p(params));
      return { changes: r.changes };
    },
    all: <T = SqlRow>(sql: string, params?: Params) => target.getAllAsync<T>(sql, p(params)),
    first: <T = SqlRow>(sql: string, params?: Params) => target.getFirstAsync<T>(sql, p(params)),
  };
}

export type JournalMode = 'wal' | 'delete' | 'keep';

export interface OpenExpoSqliteDriverOptions {
  /** File name including extension, e.g. `in_123.db`. */
  databaseName: string;
  /** Absolute directory (with or without `file://`). Defaults to expo-sqlite's directory. */
  directory?: string;
  /**
   * `wal` (default) lets reads proceed while a write transaction holds its own connection.
   * `keep` leaves the file's current mode untouched.
   */
  journalMode?: JournalMode;
  busyTimeoutMs?: number;
  /** Injected for tests; defaults to `import('expo-sqlite')`. */
  sqliteModule?: ExpoSQLiteModuleLike;
}

const openConnections = new Map<string, Promise<ExpoSqliteDriver>>();

function stripFileScheme(path: string): string {
  return path.startsWith('file://') ? decodeURI(path.slice('file://'.length)) : path;
}

export class ExpoSqliteDriver implements Driver {
  readonly name: string;

  private executor: SqlExecutor;

  private txMutex = new Mutex();

  private closed = false;

  constructor(
    private readonly db: ExpoSQLiteDatabaseLike,
    private readonly sqlite: ExpoSQLiteModuleLike,
    private readonly databaseName: string,
    private readonly directory: string | undefined,
    private readonly cacheKey: string,
  ) {
    this.name = db.databasePath || databaseName;
    this.executor = wrap(db);
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
      let result!: T;
      await this.db.withExclusiveTransactionAsync(async txn => {
        result = await fn(wrap(txn));
      });
      return result;
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    openConnections.delete(this.cacheKey);
    await this.db.closeAsync();
  }

  async deleteDatabase() {
    await this.close();
    await this.sqlite.deleteDatabaseAsync(this.databaseName, this.directory);
  }
}

/**
 * Opens (or returns the cached) connection for a database file. One connection per file path.
 */
export function openExpoSqliteDriver(options: OpenExpoSqliteDriverOptions): Promise<ExpoSqliteDriver> {
  const directory = options.directory ? stripFileScheme(options.directory) : undefined;
  const cacheKey = `${directory ?? ''}::${options.databaseName}`;
  const cached = openConnections.get(cacheKey);
  if (cached) return cached;

  const opening = (async () => {
    const sqlite =
      options.sqliteModule ??
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would fail where expo-sqlite types exist
      // @ts-ignore -- optional peer dependency; types are only present in the app
      ((await import('expo-sqlite')) as unknown as ExpoSQLiteModuleLike);
    const db = await sqlite.openDatabaseAsync(options.databaseName, {}, directory);
    const mode = options.journalMode ?? 'wal';
    if (mode !== 'keep') await db.execAsync(`PRAGMA journal_mode = ${mode}`);
    await db.execAsync(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
    return new ExpoSqliteDriver(db, sqlite, options.databaseName, directory, cacheKey);
  })();
  openConnections.set(cacheKey, opening);
  opening.catch(() => openConnections.delete(cacheKey));
  return opening;
}
