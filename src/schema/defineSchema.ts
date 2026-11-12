import type { ColumnBuilders, ColumnSchema, ColumnValue } from './columns';

export type Association =
  | { readonly type: 'has_many'; readonly foreignKey: string }
  | { readonly type: 'belongs_to'; readonly key: string };

export interface TableDefinition<C extends ColumnBuilders = ColumnBuilders> {
  columns: C;
  /** Keyed by the related table name, like WatermelonDB's `static associations`. */
  associations?: Record<string, Association>;
  /**
   * Stamp `created_at` on insert and `updated_at` on insert/update with the device clock,
   * like WatermelonDB models with `@readonly @date('created_at'/'updated_at')` fields.
   * Only columns that exist in the table are stamped.
   */
  timestamps?: boolean;
}

export type TableDefinitions = Record<string, TableDefinition>;

export interface TableSchema {
  readonly name: string;
  readonly columns: readonly ColumnSchema[];
  readonly columnMap: ReadonlyMap<string, ColumnSchema>;
  readonly associations: Readonly<Record<string, Association>>;
  readonly timestamps: { readonly createdAt: boolean; readonly updatedAt: boolean };
}

export interface Schema<T extends TableDefinitions = TableDefinitions> {
  readonly version: number;
  readonly tables: Readonly<Record<string, TableSchema>>;
  readonly tableNames: readonly string[];
  /** Type-level carrier for table definitions. */
  readonly __definitions?: T;
}

export const RESERVED_COLUMNS = new Set(['id', '_status', '_changed']);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(kind: string, name: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`[synclaire] Invalid ${kind} name: ${JSON.stringify(name)}`);
  }
}

export function buildTableSchema(name: string, def: TableDefinition): TableSchema {
  assertIdentifier('table', name);
  if (name === 'local_storage') throw new Error('[synclaire] Table name local_storage is reserved');
  const columns: ColumnSchema[] = Object.entries(def.columns).map(([colName, b]) => {
    assertIdentifier('column', colName);
    if (RESERVED_COLUMNS.has(colName)) {
      throw new Error(`[synclaire] Column name ${colName} is reserved (table ${name})`);
    }
    return { name: colName, type: b.type, isOptional: b.isOptional, isIndexed: b.isIndexed };
  });
  const columnMap = new Map(columns.map(c => [c.name, c]));
  const associations = { ...(def.associations ?? {}) };
  for (const [related, a] of Object.entries(associations)) {
    assertIdentifier('table', related);
    assertIdentifier('column', a.type === 'has_many' ? a.foreignKey : a.key);
    if (a.type === 'belongs_to' && !columnMap.has(a.key)) {
      throw new Error(`[synclaire] Association ${name} -> ${related}: column ${a.key} does not exist`);
    }
  }
  const timestamps = {
    createdAt: !!def.timestamps && columnMap.get('created_at')?.type === 'number',
    updatedAt: !!def.timestamps && columnMap.get('updated_at')?.type === 'number',
  };
  return { name, columns, columnMap, associations, timestamps };
}

export function defineSchema<T extends TableDefinitions>(input: { version: number; tables: T }): Schema<T> {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new Error('[synclaire] Schema version must be a positive integer');
  }
  const tables: Record<string, TableSchema> = {};
  for (const [name, def] of Object.entries(input.tables)) {
    tables[name] = buildTableSchema(name, def);
  }
  return { version: input.version, tables, tableNames: Object.keys(tables) };
}

// --- type helpers -----------------------------------------------------------

type DefsOf<S> = S extends Schema<infer T> ? T : never;

export type TableName<S> = Extract<keyof DefsOf<S>, string>;

type ColumnsOf<S, T extends TableName<S>> = DefsOf<S>[T]['columns'];

/** A record as returned by reads: frozen, with all schema columns plus `id` and `syncStatus`. */
export type Row<S, T extends TableName<S>> = {
  readonly id: string;
  readonly syncStatus: SyncStatus;
} & { readonly [K in keyof ColumnsOf<S, T>]: ColumnValue<ColumnsOf<S, T>[K]> };

/** Values accepted by `insert`. Missing columns get their empty value ('', 0, false or null). */
export type InsertValues<S, T extends TableName<S>> = {
  id?: string;
} & { [K in keyof ColumnsOf<S, T>]?: ColumnValue<ColumnsOf<S, T>[K]> };

/** Values accepted by `update`. */
export type UpdateValues<S, T extends TableName<S>> = {
  [K in keyof ColumnsOf<S, T>]?: ColumnValue<ColumnsOf<S, T>[K]>;
};

export type SyncStatus = 'synced' | 'created' | 'updated' | 'deleted';

/** A row including sync bookkeeping, as stored and as pushed to the server. */
export type RawRecord = { id: string; _status: SyncStatus; _changed: string } & Record<
  string,
  string | number | boolean | null
>;
