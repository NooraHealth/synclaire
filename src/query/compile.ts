import type { SqlValue } from '../driver/types';
import type { Schema, TableSchema } from '../schema/defineSchema';

import type { Clause, Comparison, Condition, Value } from './Q';

export interface CompiledQuery {
  readonly sql: string;
  readonly params: SqlValue[];
}

export interface CompileOptions {
  /** Include rows with `_status = 'deleted'` (default: false). */
  includeDeleted?: boolean;
}

const OPS = {
  eq: 'is',
  notEq: 'is not',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'like',
  notLike: 'not like',
} as const;

function encodeValue(v: Value): SqlValue {
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

function columnRef(table: TableSchema, column: string): string {
  if (column !== 'id' && !table.columnMap.has(column)) {
    throw new Error(`[synclaire] Unknown column ${table.name}.${column}`);
  }
  return `"${table.name}"."${column}"`;
}

class Compiler {
  readonly params: SqlValue[] = [];

  constructor(private readonly schema: Schema) {}

  table(name: string): TableSchema {
    const t = this.schema.tables[name];
    if (!t) throw new Error(`[synclaire] Unknown table ${name}`);
    return t;
  }

  comparison(ref: string, c: Comparison): string {
    switch (c.op) {
      case 'oneOf':
      case 'notIn': {
        const placeholders = c.values.map(v => {
          this.params.push(encodeValue(v));
          return '?';
        });
        return `${ref} ${c.op === 'oneOf' ? 'in' : 'not in'} (${placeholders.join(', ')})`;
      }
      case 'between':
        this.params.push(c.left, c.right);
        return `${ref} between ? and ?`;
      default:
        this.params.push(encodeValue(c.value));
        return `${ref} ${OPS[c.op]} ?`;
    }
  }

  condition(table: TableSchema, cond: Condition): string {
    switch (cond.type) {
      case 'where':
        return this.comparison(columnRef(table, cond.column), cond.comparison);
      case 'and':
      case 'or': {
        if (cond.conditions.length === 0) return cond.type === 'and' ? '1' : '0';
        const joiner = cond.type === 'and' ? ' and ' : ' or ';
        return `(${cond.conditions.map(c => this.condition(table, c)).join(joiner)})`;
      }
      case 'on': {
        const assoc = table.associations[cond.table];
        if (!assoc) {
          throw new Error(`[synclaire] No association from ${table.name} to ${cond.table} declared in the schema`);
        }
        const joined = this.table(cond.table);
        const link =
          assoc.type === 'has_many'
            ? `${columnRef(joined, assoc.foreignKey)} = "${table.name}"."id"`
            : `"${joined.name}"."id" = ${columnRef(table, assoc.key)}`;
        const inner = [
          link,
          ...cond.conditions.map(c => this.condition(joined, c)),
          `"${joined.name}"."_status" is not 'deleted'`,
        ];
        return `exists (select 1 from "${joined.name}" where ${inner.join(' and ')})`;
      }
      default:
        throw new Error(`[synclaire] Unknown condition ${(cond as { type: string }).type}`);
    }
  }
}

interface Parts {
  table: TableSchema;
  where: string;
  orderBy: string;
  limit: string;
  params: SqlValue[];
}

function compileParts(schema: Schema, tableName: string, clauses: readonly Clause[], options: CompileOptions): Parts {
  const compiler = new Compiler(schema);
  const table = compiler.table(tableName);
  const conditions: string[] = [];
  const orders: string[] = [];
  let take: number | undefined;
  let skip: number | undefined;

  for (const clause of clauses) {
    switch (clause.type) {
      case 'sortBy':
        orders.push(`${columnRef(table, clause.column)} ${clause.order}`);
        break;
      case 'take':
        take = clause.count;
        break;
      case 'skip':
        skip = clause.count;
        break;
      default:
        conditions.push(compiler.condition(table, clause));
    }
  }
  if (!options.includeDeleted) conditions.push(`"${table.name}"."_status" is not 'deleted'`);

  let limit = '';
  if (take) {
    limit = ` limit ${Math.max(0, Math.floor(take))}`;
    if (skip) limit += ` offset ${Math.max(0, Math.floor(skip))}`;
  }
  return {
    table,
    where: conditions.length ? ` where ${conditions.join(' and ')}` : '',
    orderBy: orders.length ? ` order by ${orders.join(', ')}` : '',
    limit,
    params: compiler.params,
  };
}

export function compileSelect(
  schema: Schema,
  tableName: string,
  clauses: readonly Clause[],
  options: CompileOptions = {},
): CompiledQuery {
  const p = compileParts(schema, tableName, clauses, options);
  return { sql: `select "${p.table.name}".* from "${p.table.name}"${p.where}${p.orderBy}${p.limit}`, params: p.params };
}

export function compileCount(
  schema: Schema,
  tableName: string,
  clauses: readonly Clause[],
  options: CompileOptions = {},
): CompiledQuery {
  const p = compileParts(schema, tableName, clauses, options);
  const inner = `select "${p.table.name}"."id" from "${p.table.name}"${p.where}${p.limit}`;
  return { sql: `select count(*) as "count" from (${inner})`, params: p.params };
}

/** Tables a query depends on (the main table plus joined tables). */
export function queryTables(tableName: string, clauses: readonly Clause[]): Set<string> {
  const tables = new Set([tableName]);
  const visit = (c: Condition): void => {
    if (c.type === 'on') {
      tables.add(c.table);
      c.conditions.forEach(visit);
    } else if (c.type === 'and' || c.type === 'or') {
      c.conditions.forEach(visit);
    }
  };
  for (const clause of clauses) {
    if (clause.type !== 'sortBy' && clause.type !== 'take' && clause.type !== 'skip') visit(clause);
  }
  return tables;
}
