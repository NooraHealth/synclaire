import type { SqlExecutor } from '../driver/types';

// Keys and encoding shared with WatermelonDB so existing app databases keep their sync state.
export const LAST_PULLED_AT_KEY = '__watermelon_last_pulled_at';
export const LAST_PULLED_SCHEMA_VERSION_KEY = '__watermelon_last_pulled_schema_version';

export async function getLocal(ex: SqlExecutor, key: string): Promise<string | null> {
  const row = await ex.first<{ value: string }>('select "value" from "local_storage" where "key" = ?', [key]);
  return row ? row.value : null;
}

export async function setLocal(ex: SqlExecutor, key: string, value: string): Promise<void> {
  await ex.run('insert or replace into "local_storage" ("key", "value") values (?, ?)', [key, value]);
}

/** `parseInt(value, 10) || null`, as WatermelonDB reads these keys. */
export function parseTimestamp(value: string | null): number | null {
  if (value === null) return null;
  return parseInt(value, 10) || null;
}

export async function getLastPulledAt(ex: SqlExecutor): Promise<number | null> {
  return parseTimestamp(await getLocal(ex, LAST_PULLED_AT_KEY));
}

export async function getLastPulledSchemaVersion(ex: SqlExecutor): Promise<number | null> {
  return parseTimestamp(await getLocal(ex, LAST_PULLED_SCHEMA_VERSION_KEY));
}
