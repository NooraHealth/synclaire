import { openDatabase, type Database, type Schema } from 'synclaire';
import { openExpoSqliteDriver } from 'synclaire/expo';

import { synclaireMigrations, synclaireSchema, type CountryCode } from '../../scenarios/countries';

export interface OpenAppDatabaseOptions {
  code: CountryCode;
  /** File name without `.db`. */
  name: string;
  /** Absolute directory; defaults to expo-sqlite's. */
  directory?: string;
  now?: () => number;
}

export async function openAppDatabase({ code, name, directory, now }: OpenAppDatabaseOptions): Promise<Database<Schema>> {
  const driver = await openExpoSqliteDriver({ databaseName: `${name}.db`, directory });
  return openDatabase({
    driver,
    schema: synclaireSchema(code) as Schema,
    migrations: synclaireMigrations(code),
    now,
  });
}
