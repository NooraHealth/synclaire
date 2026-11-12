import type { SqlExecutor, SqlRow, SqlValue } from '../driver/types';
import type { Clause } from '../query/Q';
import { compileCount, compileSelect, type CompileOptions } from '../query/compile';
import type { RawRecord, Schema, TableSchema } from '../schema/defineSchema';
import { decodeRow, encodeValue } from '../schema/sanitize';

export function tableOf(schema: Schema, name: string): TableSchema {
  const t = schema.tables[name];
  if (!t) throw new Error(`[synclaire] Unknown table ${name}`);
  return t;
}

/** Public, frozen view of a raw record. */
export function toRow<R>(raw: RawRecord, table: TableSchema): R {
  const row: Record<string, unknown> = { id: raw.id, syncStatus: raw._status };
  for (const c of table.columns) row[c.name] = raw[c.name];
  return Object.freeze(row) as R;
}

export async function getRaw(ex: SqlExecutor, table: TableSchema, id: string): Promise<RawRecord | null> {
  const row = await ex.first<SqlRow>(`select * from "${table.name}" where "id" = ? limit 1`, [id]);
  return row ? decodeRow(row, table) : null;
}

export async function queryRaw(
  ex: SqlExecutor,
  schema: Schema,
  table: string,
  clauses: readonly Clause[],
  options?: CompileOptions,
): Promise<RawRecord[]> {
  const t = tableOf(schema, table);
  const { sql, params } = compileSelect(schema, table, clauses, options);
  const rows = await ex.all<SqlRow>(sql, params);
  return rows.map(r => decodeRow(r, t));
}

export async function countRows(
  ex: SqlExecutor,
  schema: Schema,
  table: string,
  clauses: readonly Clause[],
  options?: CompileOptions,
): Promise<number> {
  const { sql, params } = compileCount(schema, table, clauses, options);
  const row = await ex.first<{ count: number }>(sql, params);
  return Number(row?.count ?? 0);
}

function allColumns(table: TableSchema): string[] {
  return ['id', '_status', '_changed', ...table.columns.map(c => c.name)];
}

function values(raw: RawRecord, columns: string[]): SqlValue[] {
  return columns.map(c => encodeValue(raw[c] ?? null));
}

export async function insertRaw(ex: SqlExecutor, table: TableSchema, raw: RawRecord): Promise<void> {
  const cols = allColumns(table);
  await ex.run(
    `insert into "${table.name}" (${cols.map(c => `"${c}"`).join(', ')}) values (${cols.map(() => '?').join(', ')})`,
    values(raw, cols),
  );
}

export async function updateRaw(ex: SqlExecutor, table: TableSchema, raw: RawRecord): Promise<void> {
  const cols = allColumns(table).slice(1);
  await ex.run(
    `update "${table.name}" set ${cols.map(c => `"${c}" = ?`).join(', ')} where "id" = ?`,
    [...values(raw, cols), raw.id],
  );
}

export async function deleteRaw(ex: SqlExecutor, table: TableSchema, id: string): Promise<void> {
  await ex.run(`delete from "${table.name}" where "id" = ?`, [id]);
}
