import type { SqlExecutor, SqlRow } from '../driver/types';
import { deleteRaw, insertRaw, updateRaw } from '../db/rows';
import type { RawRecord, Schema, TableSchema } from '../schema/defineSchema';
import { decodeRow, sanitizeRaw } from '../schema/sanitize';

import { InvalidPullError } from './errors';
import type { DirtyRaw, SyncArgs, SyncDatabaseChangeSet, SyncLog, SyncConsole, SyncTableChangeSet } from './types';

const CHUNK = 500;

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

export function areRawsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(k => left[k] === right[k]);
}

/** Per-column merge: remote values, with locally changed columns on top (WatermelonDB `resolveConflict`). */
export function resolveConflict(local: RawRecord, remote: DirtyRaw): DirtyRaw {
  if (local._status === 'deleted') return local;
  const resolved: DirtyRaw = { ...local, ...remote, id: local.id, _status: local._status, _changed: local._changed };
  for (const column of local._changed.split(',')) resolved[column] = local[column];
  return resolved;
}

function requiresUpdate(table: TableSchema, local: RawRecord, remote: DirtyRaw): boolean {
  if (local._status !== 'synced') return true;
  const sanitized = sanitizeRaw(remote, table);
  sanitized._status = 'synced';
  return !areRawsEqual(local, sanitized);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function validateRemoteRaw(raw: unknown): asserts raw is DirtyRaw {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('id' in raw) ||
    '_status' in raw ||
    '_changed' in raw
  ) {
    throw new InvalidPullError(
      "Invalid raw record supplied to Sync. Records must be objects, must have an 'id' field, and must NOT have a '_status' or '_changed' fields",
    );
  }
}

function normalizeTableChanges(table: string, value: unknown): SyncTableChangeSet {
  if (!value || typeof value !== 'object') throw new InvalidPullError(`Invalid changes for table ${table}`);
  const v = value as Partial<SyncTableChangeSet>;
  const created = v.created ?? [];
  const updated = v.updated ?? [];
  const deleted = v.deleted ?? [];
  if (!Array.isArray(created) || !Array.isArray(updated) || !Array.isArray(deleted)) {
    throw new InvalidPullError(`Invalid changes for table ${table}: created, updated and deleted must be arrays`);
  }
  return { created, updated, deleted };
}

/** Validates the pull result before anything is written. */
export function validatePull(schema: Schema, changes: unknown, logger: SyncConsole): SyncDatabaseChangeSet {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new InvalidPullError('pullChanges() returned invalid changes');
  }
  const known: SyncDatabaseChangeSet = {};
  for (const [table, value] of Object.entries(changes as Record<string, unknown>)) {
    if (!schema.tables[table]) {
      logger.warn(
        `You are trying to sync a collection named ${table}, but it does not exist. Will skip it (for forward-compatibility).`,
      );
      continue;
    }
    const tc = normalizeTableChanges(table, value);
    for (const raw of tc.created) validateRemoteRaw(raw);
    for (const raw of tc.updated) validateRemoteRaw(raw);
    for (const id of tc.deleted) {
      if (typeof id !== 'string') throw new InvalidPullError(`Invalid deleted id in table ${table}`);
    }
    known[table] = tc;
  }
  return known;
}

async function fetchNonDeletedByIds(ex: SqlExecutor, table: TableSchema, ids: string[]): Promise<Map<string, RawRecord>> {
  const map = new Map<string, RawRecord>();
  for (const part of chunks(ids)) {
    const rows = await ex.all<SqlRow>(
      `select * from "${table.name}" where "id" in (${part.map(() => '?').join(', ')}) and "_status" is not 'deleted'`,
      part,
    );
    for (const row of rows) {
      const raw = decodeRow(row, table);
      map.set(raw.id, raw);
    }
  }
  return map;
}

async function locallyDeletedIds(ex: SqlExecutor, table: TableSchema): Promise<Set<string>> {
  const rows = await ex.all<{ id: string }>(`select "id" from "${table.name}" where "_status" is 'deleted'`);
  return new Set(rows.map(r => r.id));
}

export async function destroyDeletedRecords(ex: SqlExecutor, table: TableSchema, ids: string[]): Promise<void> {
  for (const part of chunks(ids)) {
    await ex.run(
      `delete from "${table.name}" where "_status" is 'deleted' and "id" in (${part.map(() => '?').join(', ')})`,
      part,
    );
  }
}

interface ApplyContext {
  sendCreatedAsUpdated: boolean;
  log?: SyncLog;
  logger: SyncConsole;
  onConflict?: SyncArgs['onConflict'];
  conflictResolver?: SyncArgs['conflictResolver'];
}

function assertNoProto(raw: DirtyRaw): void {
  if (hasOwn(raw, '__proto__')) throw new InvalidPullError('Malicious dirtyRaw detected - contains a __proto__ key');
}

async function createFromRemote(ex: SqlExecutor, table: TableSchema, remote: DirtyRaw): Promise<void> {
  assertNoProto(remote);
  const raw = sanitizeRaw({ ...remote, _status: 'synced', _changed: '' }, table);
  await insertRaw(ex, table, raw);
}

async function updateFromRemote(
  ex: SqlExecutor,
  table: TableSchema,
  local: RawRecord,
  remote: DirtyRaw,
  ctx: ApplyContext,
): Promise<void> {
  if (!requiresUpdate(table, local, remote)) return;
  let resolved = resolveConflict(local, remote);
  if (ctx.conflictResolver) resolved = ctx.conflictResolver(table.name, local, remote, resolved);
  const newRaw = sanitizeRaw(resolved, table);
  if (local._changed) {
    if (ctx.log) {
      ctx.log.resolvedConflicts ??= [];
      ctx.log.resolvedConflicts.push({ local: { ...local }, remote: { ...remote }, resolved: { ...resolved } });
    }
    ctx.onConflict?.({ type: 'merge', table: table.name, local: { ...local }, remote: { ...remote }, resolved: newRaw });
  }
  await updateRaw(ex, table, newRaw);
}

/** Applies validated remote changes (WatermelonDB `applyRemoteChanges`, incremental strategy). */
export async function applyRemoteChanges(
  ex: SqlExecutor,
  schema: Schema,
  changes: SyncDatabaseChangeSet,
  ctx: ApplyContext,
): Promise<Set<string>> {
  const touched = new Set<string>();

  for (const [tableName, tc] of Object.entries(changes)) {
    const table = schema.tables[tableName]!;
    const ids = [...tc.created.map(r => r.id as string), ...tc.updated.map(r => r.id as string), ...tc.deleted];
    const deletedSet = new Set(tc.deleted);
    const records = ids.length ? await fetchNonDeletedByIds(ex, table, ids) : new Map<string, RawRecord>();
    const localDeleted = await locallyDeletedIds(ex, table);

    const deletedToDestroy = [...localDeleted].filter(id => deletedSet.has(id));
    if (deletedToDestroy.length) {
      await destroyDeletedRecords(ex, table, deletedToDestroy);
      touched.add(tableName);
    }

    for (const remote of tc.created) {
      const id = remote.id as string;
      const current = records.get(id);
      if (current) {
        ctx.logger.error(
          `Server wants client to create record ${tableName}#${id}, but it already exists locally. Will update existing record instead.`,
        );
        await updateFromRemote(ex, table, current, remote, ctx);
      } else if (localDeleted.has(id)) {
        ctx.logger.error(
          `Server wants client to create record ${tableName}#${id}, but it already exists locally and is marked as deleted. Will delete local record and recreate it instead.`,
        );
        await destroyDeletedRecords(ex, table, [id]);
        await createFromRemote(ex, table, remote);
      } else {
        await createFromRemote(ex, table, remote);
      }
      touched.add(tableName);
    }

    for (const remote of tc.updated) {
      const id = remote.id as string;
      const current = records.get(id);
      if (current) {
        await updateFromRemote(ex, table, current, remote, ctx);
      } else if (localDeleted.has(id)) {
        // Locally deleted; the deletion is pushed later.
        continue;
      } else {
        if (!ctx.sendCreatedAsUpdated) {
          ctx.logger.error(
            `Server wants client to update record ${tableName}#${id}, but it doesn't exist locally. Will create record instead.`,
          );
        }
        await createFromRemote(ex, table, remote);
      }
      touched.add(tableName);
    }

    for (const [id, local] of records) {
      if (!deletedSet.has(id)) continue;
      if (local._status !== 'synced') ctx.onConflict?.({ type: 'remoteDelete', table: tableName, local: { ...local } });
      if (local._status !== 'synced' && ctx.log) {
        ctx.log.resolvedConflicts ??= [];
        ctx.log.resolvedConflicts.push({ local: { ...local }, remote: { id, deleted: true }, resolved: {} });
      }
      await deleteRaw(ex, table, id);
      touched.add(tableName);
    }
  }
  return touched;
}
