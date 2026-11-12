import type { ColumnSchema } from './columns';
import type { Schema, TableSchema } from './defineSchema';
import { emptyValue } from './sanitize';

// Mirrors @nozbe/watermelondb/adapters/sqlite/encodeSchema (0.27.1) so files are interchangeable.

const STANDARD_COLUMNS = '"id" primary key, "_changed", "_status"';

export const LOCAL_STORAGE_SQL =
  'create table "local_storage" ("key" varchar(16) primary key not null, "value" text not null);' +
  'create index "local_storage_key_index" on "local_storage" ("key");';

export function encodeCreateTable(table: Pick<TableSchema, 'name' | 'columns'>): string {
  const cols = [STANDARD_COLUMNS, ...table.columns.map(c => `"${c.name}"`)].join(', ');
  return `create table "${table.name}" (${cols});`;
}

export function encodeIndex(column: ColumnSchema, tableName: string): string {
  return column.isIndexed
    ? `create index if not exists "${tableName}_${column.name}" on "${tableName}" ("${column.name}");`
    : '';
}

export function encodeTableIndices(table: Pick<TableSchema, 'name' | 'columns'>): string {
  return [
    ...table.columns.map(c => encodeIndex(c, table.name)),
    `create index if not exists "${table.name}__status" on "${table.name}" ("_status");`,
  ].join('');
}

export function encodeTable(table: Pick<TableSchema, 'name' | 'columns'>): string {
  return encodeCreateTable(table) + encodeTableIndices(table);
}

export function encodeSchema(schema: Schema): string {
  return LOCAL_STORAGE_SQL + schema.tableNames.map(n => encodeTable(schema.tables[n]!)).join('');
}

/** SQL literal for a column's empty value (used by addColumns, like Watermelon). */
export function sqlLiteral(value: string | number | boolean | null): string {
  if (value === true) return '1';
  if (value === false) return '0';
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export function encodeAddColumn(tableName: string, column: ColumnSchema): string {
  return (
    `alter table "${tableName}" add "${column.name}";` +
    `update "${tableName}" set "${column.name}" = ${sqlLiteral(emptyValue(column))};` +
    encodeIndex(column, tableName)
  );
}
