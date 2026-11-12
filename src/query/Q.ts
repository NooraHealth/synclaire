export type Value = string | number | boolean | null;

export type Comparison =
  | { readonly op: 'eq' | 'notEq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'notLike'; readonly value: Value }
  | { readonly op: 'oneOf' | 'notIn'; readonly values: readonly Value[] }
  | { readonly op: 'between'; readonly left: number; readonly right: number };

export type Condition =
  | { readonly type: 'where'; readonly column: string; readonly comparison: Comparison }
  | { readonly type: 'and'; readonly conditions: readonly Condition[] }
  | { readonly type: 'or'; readonly conditions: readonly Condition[] }
  | { readonly type: 'on'; readonly table: string; readonly conditions: readonly Condition[] };

export type Clause =
  | Condition
  | { readonly type: 'sortBy'; readonly column: string; readonly order: 'asc' | 'desc' }
  | { readonly type: 'take'; readonly count: number }
  | { readonly type: 'skip'; readonly count: number };

function toComparison(valueOrComparison: Value | Comparison): Comparison {
  if (valueOrComparison !== null && typeof valueOrComparison === 'object') return valueOrComparison;
  return { op: 'eq', value: valueOrComparison };
}

const where = (column: string, valueOrComparison: Value | Comparison): Condition => ({
  type: 'where',
  column,
  comparison: toComparison(valueOrComparison),
});

function on(table: string, conditions: Condition | readonly Condition[]): Condition;
function on(table: string, column: string, valueOrComparison: Value | Comparison): Condition;
function on(
  table: string,
  columnOrConditions: string | Condition | readonly Condition[],
  valueOrComparison?: Value | Comparison,
): Condition {
  if (typeof columnOrConditions === 'string') {
    return { type: 'on', table, conditions: [where(columnOrConditions, valueOrComparison ?? null)] };
  }
  const conditions = Array.isArray(columnOrConditions)
    ? (columnOrConditions as readonly Condition[])
    : [columnOrConditions as Condition];
  return { type: 'on', table, conditions };
}

const NON_LIKE_SAFE = /[^a-zA-Z0-9]/g;

/** Same as WatermelonDB's `Q.sanitizeLikeString`: replaces every non-alphanumeric character with `_`. */
export function sanitizeLikeString(value: string): string {
  return value.replace(NON_LIKE_SAFE, '_');
}

/** Query DSL, named like WatermelonDB's `Q` so call sites migrate mechanically. */
export const Q = {
  where,
  and: (...conditions: Condition[]): Condition => ({ type: 'and', conditions }),
  or: (...conditions: Condition[]): Condition => ({ type: 'or', conditions }),
  on,
  eq: (value: Value): Comparison => ({ op: 'eq', value }),
  notEq: (value: Value): Comparison => ({ op: 'notEq', value }),
  isNull: (): Comparison => ({ op: 'eq', value: null }),
  isNotNull: (): Comparison => ({ op: 'notEq', value: null }),
  gt: (value: number | string): Comparison => ({ op: 'gt', value }),
  gte: (value: number | string): Comparison => ({ op: 'gte', value }),
  lt: (value: number | string): Comparison => ({ op: 'lt', value }),
  lte: (value: number | string): Comparison => ({ op: 'lte', value }),
  oneOf: (values: readonly Value[]): Comparison => ({ op: 'oneOf', values }),
  notIn: (values: readonly Value[]): Comparison => ({ op: 'notIn', values }),
  like: (pattern: string): Comparison => ({ op: 'like', value: pattern }),
  notLike: (pattern: string): Comparison => ({ op: 'notLike', value: pattern }),
  between: (left: number, right: number): Comparison => ({ op: 'between', left, right }),
  sortBy: (column: string, order: 'asc' | 'desc' = 'asc'): Clause => ({ type: 'sortBy', column, order }),
  asc: 'asc' as const,
  desc: 'desc' as const,
  /** Maximum number of rows. `take(0)` means no limit, as in WatermelonDB. */
  take: (count: number): Clause => ({ type: 'take', count }),
  /** Offset. Only applied together with `take`, as in WatermelonDB. */
  skip: (count: number): Clause => ({ type: 'skip', count }),
  limit: (count: number): Clause => ({ type: 'take', count }),
  offset: (count: number): Clause => ({ type: 'skip', count }),
  sanitizeLikeString,
};
