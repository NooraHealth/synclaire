import type { SqlExecutor } from '../driver/types';
import type { ColumnBuilders, ColumnSchema } from '../schema/columns';
import { buildTableSchema, assertIdentifier, type Schema, type TableDefinition } from '../schema/defineSchema';
import { encodeAddColumn, encodeSchema, encodeTable } from '../schema/ddl';

export type MigrationStep =
  | { readonly type: 'add_columns'; readonly table: string; readonly columns: readonly ColumnSchema[] }
  | { readonly type: 'create_table'; readonly table: string; readonly definition: TableDefinition }
  | { readonly type: 'sql'; readonly sql: string };

export interface Migration {
  readonly toVersion: number;
  readonly steps: readonly MigrationStep[];
}

export interface Migrations {
  readonly migrations: readonly Migration[];
}

export function addColumns(table: string, columns: ColumnBuilders): MigrationStep {
  assertIdentifier('table', table);
  return {
    type: 'add_columns',
    table,
    columns: Object.entries(columns).map(([name, b]) => {
      assertIdentifier('column', name);
      return { name, type: b.type, isOptional: b.isOptional, isIndexed: b.isIndexed };
    }),
  };
}

export function createTable(table: string, definition: TableDefinition): MigrationStep {
  buildTableSchema(table, definition);
  return { type: 'create_table', table, definition };
}

export function unsafeExecuteSql(sql: string): MigrationStep {
  return { type: 'sql', sql };
}

export function defineMigrations(migrations: Migration[]): Migrations {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.toVersion) || m.toVersion < 2) {
      throw new Error(`[synclaire] Invalid migration toVersion ${m.toVersion}`);
    }
    if (seen.has(m.toVersion)) throw new Error(`[synclaire] Duplicate migration to ${m.toVersion}`);
    seen.add(m.toVersion);
  }
  return { migrations: [...migrations].sort((a, b) => a.toVersion - b.toVersion) };
}

export class SchemaTooNewError extends Error {
  constructor(readonly databaseVersion: number, readonly schemaVersion: number) {
    super(
      `[synclaire] Database is at schema version ${databaseVersion}, newer than the app schema (${schemaVersion}).`,
    );
    this.name = 'SchemaTooNewError';
  }
}

export class MigrationPathError extends Error {
  constructor(readonly databaseVersion: number, readonly schemaVersion: number, readonly missing: number) {
    super(
      `[synclaire] Cannot migrate from version ${databaseVersion} to ${schemaVersion}: no migration to version ${missing}.`,
    );
    this.name = 'MigrationPathError';
  }
}

export function encodeMigrationStep(step: MigrationStep): string {
  switch (step.type) {
    case 'create_table':
      return encodeTable(buildTableSchema(step.table, step.definition));
    case 'add_columns':
      return step.columns.map(c => encodeAddColumn(step.table, c)).join('');
    case 'sql':
      return step.sql;
    default:
      throw new Error(`[synclaire] Unsupported migration step ${(step as { type: string }).type}`);
  }
}

export interface SetupResult {
  action: 'created' | 'migrated' | 'none';
  fromVersion: number;
  toVersion: number;
}

/** Brings the database to `schema.version`. Never resets or drops data. */
export async function setUpDatabase(
  run: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>,
  schema: Schema,
  migrations?: Migrations,
): Promise<SetupResult> {
  return run(async tx => {
    const row = await tx.first<{ user_version: number }>('PRAGMA user_version');
    const current = Number(row?.user_version ?? 0);
    if (current === schema.version) return { action: 'none', fromVersion: current, toVersion: current };
    if (current > schema.version) throw new SchemaTooNewError(current, schema.version);

    if (current === 0) {
      await tx.exec(encodeSchema(schema));
      await tx.exec(`PRAGMA user_version = ${schema.version}`);
      return { action: 'created', fromVersion: 0, toVersion: schema.version };
    }

    const byVersion = new Map((migrations?.migrations ?? []).map(m => [m.toVersion, m]));
    const sql: string[] = [];
    for (let v = current + 1; v <= schema.version; v += 1) {
      const m = byVersion.get(v);
      if (!m) throw new MigrationPathError(current, schema.version, v);
      sql.push(...m.steps.map(encodeMigrationStep));
    }
    await tx.exec(sql.join(''));
    await tx.exec(`PRAGMA user_version = ${schema.version}`);
    return { action: 'migrated', fromVersion: current, toVersion: schema.version };
  });
}
