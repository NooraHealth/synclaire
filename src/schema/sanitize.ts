import type { SqlValue } from '../driver/types';
import { uuidv4 } from '../utils/id';

import type { ColumnSchema } from './columns';
import type { RawRecord, SyncStatus, TableSchema } from './defineSchema';

type JsValue = string | number | boolean | null;

const STATUSES = new Set<SyncStatus>(['synced', 'created', 'updated', 'deleted']);

function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Coerces a value to the column type exactly like WatermelonDB's `sanitizedRaw`: a value of the
 * wrong type becomes `null` for optional columns, otherwise the empty value ('', 0, false).
 */
export function sanitizeValue(value: unknown, column: ColumnSchema): JsValue {
  switch (column.type) {
    case 'string':
      return typeof value === 'string' ? value : column.isOptional ? null : '';
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1;
      return column.isOptional ? null : false;
    default:
      if (isValidNumber(value)) return value || 0;
      return column.isOptional ? null : 0;
  }
}

export function emptyValue(column: ColumnSchema): JsValue {
  if (column.isOptional) return null;
  return column.type === 'string' ? '' : column.type === 'number' ? 0 : false;
}

/**
 * Builds a trusted raw record from untrusted input, like WatermelonDB's `sanitizedRaw`: unknown
 * keys are dropped, and a record without a string id gets a fresh id and `created` status.
 */
export function sanitizeRaw(
  dirty: Record<string, unknown>,
  table: TableSchema,
  generateId: () => string = uuidv4,
): RawRecord {
  const raw: Record<string, JsValue> = {};
  if (typeof dirty.id === 'string') {
    raw.id = dirty.id;
    raw._status = STATUSES.has(dirty._status as SyncStatus) ? (dirty._status as SyncStatus) : 'created';
    raw._changed = typeof dirty._changed === 'string' ? dirty._changed : '';
  } else {
    raw.id = generateId();
    raw._status = 'created';
    raw._changed = '';
  }
  for (const column of table.columns) {
    const has = Object.prototype.hasOwnProperty.call(dirty, column.name);
    raw[column.name] = sanitizeValue(has ? dirty[column.name] : null, column);
  }
  return raw as RawRecord;
}

export function encodeValue(value: JsValue): SqlValue {
  if (value === true) return 1;
  if (value === false) return 0;
  return value;
}

/** Converts a stored row to a raw record (booleans decoded, values sanitized). */
export function decodeRow(row: Record<string, SqlValue>, table: TableSchema): RawRecord {
  return sanitizeRaw(row as Record<string, unknown>, table);
}
