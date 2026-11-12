import type { Database } from '../db/Database';
import type { SqlExecutor, SqlRow } from '../driver/types';
import type { RawRecord, Schema } from '../schema/defineSchema';
import { decodeRow } from '../schema/sanitize';

import { applyRemoteChanges, areRawsEqual, destroyDeletedRecords, validatePull } from './applyRemote';
import { ConcurrentSyncError, InvalidPullError, SyncAlreadyRunningError, SyncDatabaseResetError } from './errors';
import {
  getLastPulledAt,
  getLastPulledSchemaVersion,
  LAST_PULLED_AT_KEY,
  LAST_PULLED_SCHEMA_VERSION_KEY,
  setLocal,
} from './localStorageKeys';
import type { SyncArgs, SyncDatabaseChangeSet, SyncConsole, SyncRejectedIds } from './types';

const defaultLogger: SyncConsole = {
  warn: m => console.warn(`[Sync] ${m}`),
  error: m => console.error(`[Sync] ${m}`),
};

const running = new WeakSet<Database<Schema>>();

function ensureSameDatabase(db: Database<Schema>, resetCount: number): void {
  if (db.resetCount !== resetCount) throw new SyncDatabaseResetError();
}

export interface LocalChanges {
  changes: SyncDatabaseChangeSet<RawRecord>;
  /** Snapshot of every pushed created/updated raw, kept separately from what `pushChanges` receives. */
  snapshot: Map<string, Map<string, RawRecord>>;
}

async function fetchTableChanges(ex: SqlExecutor, schema: Schema, tableName: string) {
  const table = schema.tables[tableName]!;
  const fetch = async (status: 'created' | 'updated') =>
    (await ex.all<SqlRow>(`select * from "${tableName}" where "_status" is ?`, [status])).map(r => decodeRow(r, table));
  const created = await fetch('created');
  const updated = await fetch('updated');
  const deleted = (await ex.all<{ id: string }>(`select "id" from "${tableName}" where "_status" is 'deleted'`)).map(
    r => r.id,
  );
  return { created, updated, deleted };
}

export async function fetchLocalChanges<S extends Schema>(db: Database<S>): Promise<LocalChanges> {
  return db._readRaw(async ex => {
    const changes: SyncDatabaseChangeSet<RawRecord> = {};
    const snapshot = new Map<string, Map<string, RawRecord>>();
    for (const tableName of db.schema.tableNames) {
      const tc = await fetchTableChanges(ex, db.schema, tableName);
      snapshot.set(tableName, new Map([...tc.created, ...tc.updated].map(r => [r.id, { ...r }])));
      changes[tableName] = tc;
    }
    return { changes, snapshot };
  });
}

function isChangeSetEmpty(changes: SyncDatabaseChangeSet<unknown>): boolean {
  return Object.values(changes).every(t => t.created.length + t.updated.length + t.deleted.length === 0);
}

function changeSetCount(changes: SyncDatabaseChangeSet<unknown>): number {
  return Object.values(changes).reduce((n, t) => n + t.created.length + t.updated.length + t.deleted.length, 0);
}

export async function markLocalChangesAsSynced<S extends Schema>(
  db: Database<S>,
  local: LocalChanges,
  rejectedIds: SyncRejectedIds = {},
): Promise<void> {
  await db._writeRaw(async ex => {
    const changed = new Set<string>();
    for (const [tableName, pushed] of local.snapshot) {
      const table = db.schema.tables[tableName]!;
      const rejected = new Set(rejectedIds[tableName] ?? []);
      for (const [id, snapshotRaw] of pushed) {
        if (rejected.has(id)) continue;
        const row = await ex.first<SqlRow>(`select * from "${tableName}" where "id" = ?`, [id]);
        if (!row) continue;
        if (!areRawsEqual(decodeRow(row, table), snapshotRaw)) continue;
        await ex.run(`update "${tableName}" set "_status" = 'synced', "_changed" = '' where "id" = ?`, [id]);
        changed.add(tableName);
      }
      const deleted = (local.changes[tableName]?.deleted ?? []).filter(id => !rejected.has(id));
      if (deleted.length) {
        await destroyDeletedRecords(ex, table, deleted);
        changed.add(tableName);
      }
    }
    return { result: undefined, changed };
  });
}

/** Mirrors WatermelonDB's `synchronize()` (0.27.1), without migration syncs or turbo login. */
export async function synchronize<S extends Schema>(args: SyncArgs<S>): Promise<void> {
  const { database: db, pullChanges, pushChanges, log } = args;
  const logger = args.logger ?? defaultLogger;
  const dbKey = db as unknown as Database<Schema>;
  if (running.has(dbKey)) throw new SyncAlreadyRunningError();
  running.add(dbKey);

  try {
    const resetCount = db.resetCount;
    if (log) {
      log.startedAt = new Date();
      log.phase = 'starting';
    }

    const { lastPulledAt, lastPulledSchemaVersion } = await db._readRaw(async ex => ({
      lastPulledAt: await getLastPulledAt(ex),
      lastPulledSchemaVersion: await getLastPulledSchemaVersion(ex),
    }));
    if (log) {
      log.lastPulledAt = lastPulledAt;
      log.lastPulledSchemaVersion = lastPulledSchemaVersion;
      log.migration = null;
    }
    const isFirstSync = !lastPulledAt;
    if (lastPulledSchemaVersion && isFirstSync) {
      logger.error(
        'lastPulledSchemaVersion is set, but this is the first sync. This most likely means that the backend does not return a correct timestamp',
      );
    }
    const schemaVersion = db.schema.version;
    if (log) log.phase = 'ready to pull';

    const pullResult = await pullChanges({ lastPulledAt, schemaVersion, migration: null });
    if (log) log.phase = 'pulled';
    if (!pullResult || typeof pullResult !== 'object') {
      throw new InvalidPullError('pullChanges() returned an invalid result');
    }
    const { changes: rawChanges, timestamp: newLastPulledAt, ...rest } = pullResult;
    const remoteChanges = validatePull(db.schema, rawChanges, logger);
    if (typeof newLastPulledAt !== 'number' || !(newLastPulledAt > 0)) {
      throw new InvalidPullError(
        `pullChanges() returned invalid timestamp ${String(newLastPulledAt)}. timestamp must be a non-zero number`,
      );
    }
    const remoteChangeCount = changeSetCount(rawChanges as SyncDatabaseChangeSet<unknown>);
    if (args.onWillApplyRemoteChanges) await args.onWillApplyRemoteChanges({ remoteChangeCount });

    await db._writeRaw(async ex => {
      ensureSameDatabase(dbKey, resetCount);
      if (lastPulledAt !== (await getLastPulledAt(ex))) throw new ConcurrentSyncError();
      if (log) {
        log.newLastPulledAt = newLastPulledAt;
        log.remoteChangeCount = remoteChangeCount;
      }

      const changed = await applyRemoteChanges(ex, db.schema, remoteChanges, {
        sendCreatedAsUpdated: !!args.sendCreatedAsUpdated,
        log,
        logger,
        onConflict: args.onConflict,
        conflictResolver: args.conflictResolver,
      });
      args.onDidPullChanges?.(rest);
      if (log) log.phase = 'applied remote changes';

      const previous = (await getLastPulledAt(ex)) ?? 0;
      if (newLastPulledAt < previous) {
        logger.error(
          `Pull has finished and received server time ${newLastPulledAt} — but previous pulled-at time was greater - ${previous}. This is most likely server bug.`,
        );
      }
      await setLocal(ex, LAST_PULLED_AT_KEY, `${newLastPulledAt}`);
      if (isFirstSync) await setLocal(ex, LAST_PULLED_SCHEMA_VERSION_KEY, `${schemaVersion}`);
      return { result: undefined, changed };
    });

    if (pushChanges) {
      if (log) log.phase = 'ready to fetch local changes';
      const localChanges = await fetchLocalChanges(db);
      if (log) {
        log.localChangeCount = changeSetCount(localChanges.changes);
        log.phase = 'fetched local changes';
      }
      ensureSameDatabase(dbKey, resetCount);
      if (!isChangeSetEmpty(localChanges.changes)) {
        if (log) log.phase = 'ready to push';
        const pushResult = (await pushChanges({ changes: localChanges.changes, lastPulledAt: newLastPulledAt })) || {};
        if (log) {
          log.phase = 'pushed';
          log.rejectedIds = pushResult.experimentalRejectedIds;
        }
        ensureSameDatabase(dbKey, resetCount);
        await markLocalChangesAsSynced(db, localChanges, pushResult.experimentalRejectedIds);
        if (log) log.phase = 'marked local changes as synced';
      }
    } else if (log) {
      log.phase = 'pushChanges not defined';
    }

    if (log) {
      log.finishedAt = new Date();
      log.phase = 'done';
    }
  } catch (error) {
    if (log) log.error = error as Error;
    throw error;
  } finally {
    running.delete(dbKey);
  }
}

export async function hasUnsyncedChanges<S extends Schema>({ database }: { database: Database<S> }): Promise<boolean> {
  return database._readRaw(async ex => {
    for (const tableName of database.schema.tableNames) {
      const row = await ex.first<{ n: number }>(
        `select count(*) as "n" from "${tableName}" where "_status" in ('created', 'updated', 'deleted')`,
      );
      if (Number(row?.n ?? 0) > 0) return true;
    }
    return false;
  });
}

