import type { SqlExecutor } from '../driver/types';
import type { Clause } from '../query/Q';
import type {
  InsertValues,
  RawRecord,
  Row,
  Schema,
  TableName,
  TableSchema,
  UpdateValues,
} from '../schema/defineSchema';
import { sanitizeRaw, sanitizeValue } from '../schema/sanitize';

import { DeletedRecordError, RecordNotFoundError, TransactionFinishedError } from './errors';
import { setRawColumnChange } from './rawSet';
import { countRows, deleteRaw, getRaw, insertRaw, queryRaw, tableOf, toRow, updateRaw } from './rows';

export interface WriteOptions {
  now: () => number;
  generateId: () => string;
  deleteCreatedImmediately: boolean;
}

/**
 * Handle passed to `db.write(fn)`. All methods must be awaited before `fn` resolves; using the
 * handle afterwards throws `TransactionFinishedError`.
 */
export class WriteTx<S extends Schema> {
  private finished = false;
  /** @internal */
  readonly changedTables = new Set<string>();

  /** @internal */
  constructor(
    private readonly ex: SqlExecutor,
    private readonly schema: S,
    private readonly options: WriteOptions,
  ) {}

  /** @internal */
  finish(): void {
    this.finished = true;
  }

  private guard(): void {
    if (this.finished) throw new TransactionFinishedError();
  }

  private table(name: string): TableSchema {
    return tableOf(this.schema, name);
  }

  // --- reads ----------------------------------------------------------------

  /** Returns the record, including one marked as deleted (like WatermelonDB `find`), or null. */
  async get<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T> | null> {
    this.guard();
    const t = this.table(table);
    const raw = await getRaw(this.ex, t, id);
    return raw ? toRow<Row<S, T>>(raw, t) : null;
  }

  async find<T extends TableName<S>>(table: T, id: string): Promise<Row<S, T>> {
    const row = await this.get(table, id);
    if (!row) throw new RecordNotFoundError(table, id);
    return row;
  }

  async query<T extends TableName<S>>(table: T, ...clauses: Clause[]): Promise<Row<S, T>[]> {
    this.guard();
    const t = this.table(table);
    const raws = await queryRaw(this.ex, this.schema, table, clauses);
    return raws.map(r => toRow<Row<S, T>>(r, t));
  }

  async count<T extends TableName<S>>(table: T, ...clauses: Clause[]): Promise<number> {
    this.guard();
    return countRows(this.ex, this.schema, table, clauses);
  }

  // --- writes ---------------------------------------------------------------

  async insert<T extends TableName<S>>(table: T, values: InsertValues<S, T>): Promise<Row<S, T>> {
    this.guard();
    const t = this.table(table);
    const input = values as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key !== 'id' && !t.columnMap.has(key)) {
        throw new Error(`[synclaire] Unknown column ${table}.${key}`);
      }
    }
    const now = this.options.now();
    const dirty: Record<string, unknown> = {};
    if (t.timestamps.createdAt) dirty.created_at = now;
    if (t.timestamps.updatedAt) dirty.updated_at = now;
    for (const [k, v] of Object.entries(input)) if (v !== undefined) dirty[k] = v;
    dirty.id = typeof input.id === 'string' && input.id ? input.id : this.options.generateId();
    dirty._status = 'created';
    dirty._changed = '';
    const raw = sanitizeRaw(dirty, t);
    await insertRaw(this.ex, t, raw);
    this.changedTables.add(table);
    return toRow<Row<S, T>>(raw, t);
  }

  async update<T extends TableName<S>>(table: T, id: string, patch: UpdateValues<S, T>): Promise<Row<S, T>> {
    this.guard();
    const t = this.table(table);
    const raw = await getRaw(this.ex, t, id);
    if (!raw) throw new RecordNotFoundError(table, id);
    const entries = Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (raw._status === 'deleted') {
      // As in WatermelonDB, only setting a column is refused; an update that sets nothing is a no-op.
      if (t.timestamps.updatedAt || entries.length) throw new DeletedRecordError(table, id);
      return toRow<Row<S, T>>(raw, t);
    }

    const set = (column: string, value: unknown): void => {
      const c = t.columnMap.get(column);
      if (!c) throw new Error(`[synclaire] Unknown column ${table}.${column}`);
      const before = raw[column];
      raw[column] = sanitizeValue(value, c);
      if (before !== raw[column]) setRawColumnChange(raw, column);
    };

    if (t.timestamps.updatedAt) set('updated_at', this.options.now());
    for (const [k, v] of entries) set(k, v);
    await updateRaw(this.ex, t, raw);
    this.changedTables.add(table);
    return toRow<Row<S, T>>(raw, t);
  }

  /**
   * Marks a record as deleted so the deletion is pushed on next sync. A record that was never
   * synced (`created`) is removed immediately unless `deleteCreatedImmediately` is false.
   */
  async markDeleted<T extends TableName<S>>(table: T, id: string): Promise<void> {
    this.guard();
    const t = this.table(table);
    const raw = await getRaw(this.ex, t, id);
    if (!raw) throw new RecordNotFoundError(table, id);
    await this.markRawDeleted(t, raw);
  }

  private async markRawDeleted(t: TableSchema, raw: RawRecord): Promise<void> {
    if (raw._status === 'deleted') return;
    if (raw._status === 'created' && this.options.deleteCreatedImmediately) {
      await deleteRaw(this.ex, t, raw.id);
    } else {
      raw._status = 'deleted';
      await updateRaw(this.ex, t, raw);
    }
    this.changedTables.add(t.name);
  }

  /** Marks every matching (non-deleted) record as deleted. Returns the number of records. */
  async markDeletedWhere<T extends TableName<S>>(table: T, ...clauses: Clause[]): Promise<number> {
    this.guard();
    const t = this.table(table);
    const raws = await queryRaw(this.ex, this.schema, table, clauses);
    for (const raw of raws) await this.markRawDeleted(t, raw);
    return raws.length;
  }

  /** Removes the record without telling the server. */
  async destroyPermanently<T extends TableName<S>>(table: T, id: string): Promise<void> {
    this.guard();
    const t = this.table(table);
    await deleteRaw(this.ex, t, id);
    this.changedTables.add(table);
  }

  async destroyPermanentlyWhere<T extends TableName<S>>(table: T, ...clauses: Clause[]): Promise<number> {
    this.guard();
    const t = this.table(table);
    const raws = await queryRaw(this.ex, this.schema, table, clauses, { includeDeleted: true });
    for (const raw of raws) await deleteRaw(this.ex, t, raw.id);
    if (raws.length) this.changedTables.add(table);
    return raws.length;
  }
}
