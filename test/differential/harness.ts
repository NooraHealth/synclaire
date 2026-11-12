/**
 * Runs the same operations against WatermelonDB 0.27.1 (Node SQLite adapter) and Synclaire, each on
 * its own database file, and exposes dumps and push payloads for comparison.
 */
import { createRequire } from 'node:module';

import { openDatabase, Q, synchronize, hasUnsyncedChanges, type Database, type Schema } from '../../src';
import { BetterSqliteDriver } from '../../src/testing';
import {
  synclaireMigrations,
  synclaireSchema,
  watermelonMigrations,
  watermelonModels,
  watermelonSchema,
  type CountryCode,
} from '../fixtures/countries';
import { dumpFile, tmpDbPath, type DbDump } from '../helpers';

const require = createRequire(import.meta.url);
const wm = require('@nozbe/watermelondb') as any;
const SQLiteAdapter = require('@nozbe/watermelondb/adapters/sqlite').default as any;
const wmSync = require('@nozbe/watermelondb/sync') as any;
const wmLogger = require('@nozbe/watermelondb/utils/common/logger').default as any;
wmLogger.silence();

export type Values = Record<string, string | number | boolean | null>;

export interface PullResponse {
  changes: Record<string, { created: Values[]; updated: Values[]; deleted: string[] }>;
  timestamp: number;
}

export interface SyncServer {
  pull(lastPulledAt: number | null): Promise<PullResponse>;
  /** Throws to simulate a failed push (e.g. HTTP 400). */
  push(changes: unknown, lastPulledAt: number): Promise<void>;
}

export interface SyncOutcome {
  ok: boolean;
  error?: string;
  pushed: unknown[];
}

export interface Client {
  readonly kind: 'watermelon' | 'synclaire';
  readonly file: string;
  insert(table: string, values: Values & { id: string }): Promise<void>;
  update(table: string, id: string, patch: Values): Promise<void>;
  markDeleted(table: string, id: string): Promise<void>;
  markDeletedWhere(table: string, column: string, value: string): Promise<void>;
  destroyPermanently(table: string, id: string): Promise<void>;
  sync(server: SyncServer): Promise<SyncOutcome>;
  hasUnsyncedChanges(): Promise<boolean>;
  reset(): Promise<void>;
  dump(): DbDump;
}

/** Shared fake clock: WatermelonDB reads Date.now(), Synclaire is given `now`. */
export class FakeClock {
  t = 1_790_000_000_000;
  private original = Date.now;

  install(): void {
    Date.now = () => this.t;
  }

  uninstall(): void {
    Date.now = this.original;
  }

  advance(ms = 1000): void {
    this.t += ms;
  }
}

async function capture(server: SyncServer, run: (s: SyncServer, pushed: unknown[]) => Promise<void>): Promise<SyncOutcome> {
  const pushed: unknown[] = [];
  try {
    await run(server, pushed);
    return { ok: true, pushed };
  } catch (e) {
    return { ok: false, error: (e as Error).message, pushed };
  }
}

const TABLES = ['patient_sessions', 'nurses', 'patient_session_nurses'];

export class WatermelonClient implements Client {
  readonly kind = 'watermelon' as const;
  readonly file: string;
  readonly db: any;

  constructor(code: CountryCode, file = tmpDbPath(`wm-${code}`)) {
    this.file = file;
    const adapter = new SQLiteAdapter({
      dbName: file,
      schema: watermelonSchema(code),
      migrations: watermelonMigrations(code),
    });
    this.db = new wm.Database({ adapter, modelClasses: watermelonModels() });
  }

  async insert(table: string, values: Values & { id: string }) {
    await this.db.write(() =>
      this.db.get(table).create((r: any) => {
        r._raw.id = values.id;
        for (const [k, v] of Object.entries(values)) if (k !== 'id') r._setRaw(k, v);
      }),
    );
  }

  /**
   * `collection.find` serves records from WatermelonDB's in-memory cache, which still holds records
   * that sync has already purged from SQLite (pushed deletions). Synclaire has no such cache and
   * reports them as not found, so look the row up in SQLite first.
   */
  private async find(table: string, id: string): Promise<any> {
    const rows = await this.db
      .get(table)
      .query(wm.Q.unsafeSqlQuery(`select id from ${table} where id = ?`, [id]))
      .unsafeFetchRaw();
    if (!rows.length) throw new Error(`${table}#${id} not found`);
    return this.db.get(table).find(id);
  }

  async update(table: string, id: string, patch: Values) {
    await this.db.write(async () => {
      const rec = await this.find(table, id);
      await rec.update((r: any) => {
        for (const [k, v] of Object.entries(patch)) r._setRaw(k, v);
      });
    });
  }

  async markDeleted(table: string, id: string) {
    await this.db.write(async () => {
      const rec = await this.find(table, id);
      await rec.markAsDeleted();
    });
  }

  async markDeletedWhere(table: string, column: string, value: string) {
    await this.db.write(async () => {
      const recs = await this.db.get(table).query(wm.Q.where(column, value)).fetch();
      await this.db.batch(recs.map((r: any) => r.prepareMarkAsDeleted()));
    });
  }

  async destroyPermanently(table: string, id: string) {
    await this.db.write(async () => {
      const rec = await this.find(table, id);
      await rec.destroyPermanently();
    });
  }

  sync(server: SyncServer) {
    return capture(server, async (s, pushed) => {
      await wmSync.synchronize({
        database: this.db,
        sendCreatedAsUpdated: true,
        pullChanges: ({ lastPulledAt }: { lastPulledAt: number | null }) => s.pull(lastPulledAt),
        pushChanges: async ({ changes, lastPulledAt }: { changes: unknown; lastPulledAt: number }) => {
          pushed.push(JSON.parse(JSON.stringify(changes)));
          await s.push(changes, lastPulledAt);
        },
      });
    });
  }

  hasUnsyncedChanges() {
    return wmSync.hasUnsyncedChanges({ database: this.db }) as Promise<boolean>;
  }

  async reset() {
    await this.db.write(() => this.db.unsafeResetDatabase());
  }

  dump() {
    return dumpFile(this.file, TABLES);
  }
}

export class SynclaireClient implements Client {
  readonly kind = 'synclaire' as const;

  private constructor(
    readonly file: string,
    readonly db: Database<Schema>,
  ) {}

  static async open(code: CountryCode, file = tmpDbPath(`sc-${code}`)): Promise<SynclaireClient> {
    const db = await openDatabase({
      driver: new BetterSqliteDriver({ path: file }),
      schema: synclaireSchema(code) as Schema,
      migrations: synclaireMigrations(code),
      now: () => Date.now(),
      deleteCreatedImmediately: false,
    });
    return new SynclaireClient(file, db);
  }

  async insert(table: string, values: Values & { id: string }) {
    await this.db.write(tx => tx.insert(table, values));
  }

  async update(table: string, id: string, patch: Values) {
    await this.db.write(tx => tx.update(table, id, patch));
  }

  async markDeleted(table: string, id: string) {
    await this.db.write(tx => tx.markDeleted(table, id));
  }

  async markDeletedWhere(table: string, column: string, value: string) {
    await this.db.write(tx => tx.markDeletedWhere(table, Q.where(column, value)));
  }

  async destroyPermanently(table: string, id: string) {
    await this.db.write(async tx => {
      await tx.find(table, id);
      await tx.destroyPermanently(table, id);
    });
  }

  sync(server: SyncServer) {
    const quiet = { warn: () => undefined, error: () => undefined };
    return capture(server, async (s, pushed) => {
      await synchronize({
        database: this.db,
        sendCreatedAsUpdated: true,
        logger: quiet,
        pullChanges: ({ lastPulledAt }) => s.pull(lastPulledAt) as never,
        pushChanges: async ({ changes, lastPulledAt }) => {
          pushed.push(JSON.parse(JSON.stringify(changes)));
          await s.push(changes, lastPulledAt);
        },
      });
    });
  }

  hasUnsyncedChanges() {
    return hasUnsyncedChanges({ database: this.db });
  }

  reset() {
    return this.db.reset();
  }

  dump() {
    return dumpFile(this.file, TABLES);
  }
}

/**
 * Differences that are deliberate and allowed. Each entry normalises both sides before comparison.
 * - error text: Synclaire's error messages differ from Watermelon's invariant messages.
 */
export function normaliseOutcome(o: { ok: boolean; error?: string }) {
  return { ok: o.ok };
}

/** Runs an async op on a client and records whether it threw. */
export async function attempt(fn: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
