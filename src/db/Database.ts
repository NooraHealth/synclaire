import type { Driver, SqlExecutor } from '../driver/types';
import { setUpDatabase, type Migrations, type SetupResult } from '../migrations';
import type { Clause } from '../query/Q';
import type { Row, Schema, TableName } from '../schema/defineSchema';
import { encodeSchema } from '../schema/ddl';
import { uuidv4 } from '../utils/id';
import { Mutex } from '../utils/Mutex';

import { RecordNotFoundError } from './errors';
import { countRows, getRaw, queryRaw, tableOf, toRow } from './rows';
import { WriteTx, type WriteOptions } from './WriteTx';

export interface OpenDatabaseOptions<S extends Schema> {
  driver: Driver;
  schema: S;
  migrations?: Migrations;
  /** Clock used for `created_at`/`updated_at` stamps. Defaults to `Date.now`. */
  now?: () => number;
  /** Id generator for inserts without an explicit id. Defaults to UUID v4. */
  generateId?: () => string;
  /**
   * When true (default), `markDeleted` on a record that was never synced removes it right away.
   * Set to false to keep it as `deleted` until the next push, exactly like WatermelonDB.
   */
  deleteCreatedImmediately?: boolean;
}

export type ChangeListener = (tables: ReadonlySet<string>) => void;

export interface LocalStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class Database<S extends Schema = Schema> {
  private readonly writeLock = new Mutex();
  private readonly listeners = new Set<ChangeListener>();
  private readonly writeOptions: WriteOptions;
  private resetCounter = 0;
  private closed = false;

  readonly localStorage: LocalStorage;

  private constructor(
    readonly driver: Driver,
    readonly schema: S,
    readonly setup: SetupResult,
    options: OpenDatabaseOptions<S>,
  ) {
    this.writeOptions = {
      now: options.now ?? Date.now,
      generateId: options.generateId ?? uuidv4,
      deleteCreatedImmediately: options.deleteCreatedImmediately ?? true,
    };
    this.localStorage = {
      get: async key => {
        const row = await this.driver.first<{ value: string }>(
          'select "value" from "local_storage" where "key" = ?',
          [key],
        );
        return row ? row.value : null;
      },
      set: (key, value) => {
        if (typeof value !== 'string') {
          return Promise.reject(new Error('[synclaire] localStorage values must be strings'));
        }
        return this.writeLock.runExclusive(async () => {
          await this.driver.run('insert or replace into "local_storage" ("key", "value") values (?, ?)', [key, value]);
        });
      },
      remove: key =>
        this.writeLock.runExclusive(async () => {
          await this.driver.run('delete from "local_storage" where "key" = ?', [key]);
        }),
    };
  }

  static async open<S extends Schema>(options: OpenDatabaseOptions<S>): Promise<Database<S>> {
    const setup = await setUpDatabase(fn => options.driver.transaction(fn), options.schema, options.migrations);
    return new Database(options.driver, options.schema, setup, options);
  }

  /** Incremented on every `reset()`. Long-running operations use it to detect a reset. */
  get resetCount(): number {
    return this.resetCounter;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // --- reads (not queued; see a consistent snapshot per statement) ------------

  async get<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T> | null> {
    const t = tableOf(this.schema, table);
    const raw = await getRaw(this.driver, t, id);
    return raw ? toRow<Row<S, T>>(raw, t) : null;
  }

  async find<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T>> {
    const row = await this.get(table, id);
    if (!row) throw new RecordNotFoundError(table, id);
    return row;
  }

  async query<T extends TableName<S>>(table: T, ...clauses: Clause[]): Promise<Row<S, T>[]> {
    const t = tableOf(this.schema, table);
    const raws = await queryRaw(this.driver, this.schema, table, clauses);
    return raws.map(r => toRow<Row<S, T>>(r, t));
  }

  async count<T extends TableName<S>>(table: T, ...clauses: Clause[]): Promise<number> {
    return countRows(this.driver, this.schema, table, clauses);
  }

  /** Runs several reads against one transaction-consistent snapshot. */
  async read<R>(fn: (tx: Pick<WriteTx<S>, 'get' | 'find' | 'query' | 'count'>) => Promise<R>): Promise<R> {
    return this.write(fn, { silent: true });
  }

  // --- writes ---------------------------------------------------------------

  /**
   * Runs `fn` in a serialized SQLite transaction. Everything commits or nothing does. Change
   * listeners are notified after commit.
   */
  async write<R>(fn: (tx: WriteTx<S>) => Promise<R>, opts: { silent?: boolean } = {}): Promise<R> {
    let changed: Set<string> = new Set();
    const result = await this.writeLock.runExclusive(() =>
      this.driver.transaction(async ex => {
        const tx = new WriteTx(ex, this.schema, this.writeOptions);
        try {
          const r = await fn(tx);
          changed = tx.changedTables;
          return r;
        } finally {
          tx.finish();
        }
      }),
    );
    if (!opts.silent && changed.size) this.emit(changed);
    return result;
  }

  /**
   * @internal Low-level transactional access for the sync engine. `fn` returns the set of tables
   * it changed.
   */
  async _writeRaw<R>(fn: (ex: SqlExecutor) => Promise<{ result: R; changed: ReadonlySet<string> }>): Promise<R> {
    const { result, changed } = await this.writeLock.runExclusive(() => this.driver.transaction(fn));
    if (changed.size) this.emit(changed);
    return result;
  }

  /** @internal Reads from one consistent snapshot, ordered with respect to writes. */
  async _readRaw<R>(fn: (ex: SqlExecutor) => Promise<R>): Promise<R> {
    return this.writeLock.runExclusive(() => this.driver.transaction(fn));
  }

  /** Deletes all data and local storage, and recreates the schema. */
  async reset(): Promise<void> {
    await this.writeLock.runExclusive(() =>
      this.driver.transaction(async ex => {
        const tables = await ex.all<{ name: string }>(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'",
        );
        for (const { name } of tables) await ex.exec(`drop table if exists "${name.replace(/"/g, '""')}"`);
        await ex.exec(encodeSchema(this.schema));
        await ex.exec(`PRAGMA user_version = ${this.schema.version}`);
      }),
    );
    this.resetCounter += 1;
    this.emit(new Set(this.schema.tableNames));
  }

  // --- change events --------------------------------------------------------

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(tables: ReadonlySet<string>): void {
    for (const l of [...this.listeners]) {
      try {
        l(tables);
      } catch (e) {
        console.error('[synclaire] change listener threw', e);
      }
    }
  }

  async close(): Promise<void> {
    await this.writeLock.runExclusive(async () => {
      this.closed = true;
      await this.driver.close();
    });
  }
}

export function openDatabase<S extends Schema>(options: OpenDatabaseOptions<S>): Promise<Database<S>> {
  return Database.open(options);
}
