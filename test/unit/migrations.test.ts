import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import {
  addColumns,
  col,
  createTable,
  defineMigrations,
  defineSchema,
  MigrationPathError,
  SchemaTooNewError,
  unsafeExecuteSql,
} from '../../src';
import { encodeMigrationStep } from '../../src/migrations';
import { BetterSqliteDriver } from '../../src/testing';
import {
  COUNTRIES,
  synclaireMigrations,
  synclaireSchema,
  synclaireSchemaV1,
  watermelonMigrations,
} from '../fixtures/countries';
import { dumpFile, openTestDb, tmpDbPath } from '../helpers';

const require = createRequire(import.meta.url);
const { encodeMigrationSteps } = require('@nozbe/watermelondb/adapters/sqlite/encodeSchema') as {
  encodeMigrationSteps: (steps: unknown[]) => string;
};

describe('migration runner', () => {
  it('creates a fresh database at the schema version', async () => {
    const { db, path } = await openTestDb(synclaireSchema('in'));
    expect(db.setup).toEqual({ action: 'created', fromVersion: 0, toVersion: 3 });
    await db.close();
    expect(dumpFile(path).user_version).toBe(3);
  });

  it('does nothing when already at the version', async () => {
    const path = tmpDbPath();
    await (await openTestDb(synclaireSchema('in'), { path })).db.close();
    const { db } = await openTestDb(synclaireSchema('in'), { path, migrations: synclaireMigrations('in') });
    expect(db.setup.action).toBe('none');
    await db.close();
  });

  it.each(COUNTRIES)('upgrades %s from v1 and keeps data', async code => {
    const path = tmpDbPath();
    const v1 = await openTestDb(synclaireSchemaV1(code), { path });
    await v1.db.write(async tx => {
      await tx.insert('patient_sessions', { id: 's1', created_by: 'n1' });
      await tx.insert('nurses', { id: 'n1', name: 'Asha' });
    });
    await v1.db.close();

    const latest = synclaireSchema(code);
    const { db } = await openTestDb(latest, { path, migrations: synclaireMigrations(code) });
    expect(db.setup).toEqual({ action: 'migrated', fromVersion: 1, toVersion: latest.version });
    const nurse = await db.find('nurses', 'n1');
    expect(nurse.name).toBe('Asha');
    // addColumns fills non-optional numbers with 0 (Watermelon semantics), even though the schema says optional
    expect(nurse.privacy_consent_timestamp).toBe(0);
    expect((await db.find('patient_sessions', 's1')).created_by).toBe('n1');
    await db.close();

    const fresh = await openTestDb(latest);
    await fresh.db.close();
    const migratedTables = dumpFile(path).ddl.map(d => d.name).sort();
    expect(migratedTables).toEqual(dumpFile(fresh.path).ddl.map(d => d.name).sort());
    expect(dumpFile(path).user_version).toBe(latest.version);
  });

  it.each(COUNTRIES)('generates the same migration SQL as WatermelonDB (%s)', code => {
    const ours = synclaireMigrations(code).migrations.flatMap(m => m.steps.map(encodeMigrationStep)).join('');
    const theirs = encodeMigrationSteps(watermelonMigrations(code).sortedMigrations.flatMap(m => m.steps));
    expect(ours).toBe(theirs);
  });

  it('throws on a missing migration path and leaves the database untouched', async () => {
    const path = tmpDbPath();
    await (await openTestDb(synclaireSchemaV1('in'), { path })).db.close();
    const onlyTo3 = defineMigrations([{ toVersion: 3, steps: [] }]);
    await expect(openTestDb(synclaireSchema('in'), { path, migrations: onlyTo3 })).rejects.toBeInstanceOf(
      MigrationPathError,
    );
    expect(dumpFile(path).user_version).toBe(1);
  });

  it('throws when the database is newer than the schema', async () => {
    const path = tmpDbPath();
    await (await openTestDb(synclaireSchema('in'), { path })).db.close();
    await expect(openTestDb(synclaireSchemaV1('in'), { path })).rejects.toBeInstanceOf(SchemaTooNewError);
  });

  it('rolls back a failing migration', async () => {
    const path = tmpDbPath();
    const v1 = defineSchema({ version: 1, tables: { t: { columns: { a: col.string() } } } });
    await (await openTestDb(v1, { path })).db.close();
    const v2 = defineSchema({ version: 2, tables: { t: { columns: { a: col.string(), b: col.number() } } } });
    const bad = defineMigrations([
      { toVersion: 2, steps: [addColumns('t', { b: col.number() }), unsafeExecuteSql('this is not sql;')] },
    ]);
    await expect(openTestDb(v2, { path, migrations: bad })).rejects.toThrow();
    const dump = dumpFile(path);
    expect(dump.user_version).toBe(1);
    expect(dump.ddl.find(d => d.name === 't')!.sql).not.toContain('"b"');
  });

  it('supports createTable and indexed addColumns', async () => {
    const path = tmpDbPath();
    const v1 = defineSchema({ version: 1, tables: { t: { columns: { a: col.string() } } } });
    await (await openTestDb(v1, { path })).db.close();
    const v2 = defineSchema({
      version: 2,
      tables: {
        t: { columns: { a: col.string(), b: col.string().indexed() } },
        u: { columns: { x: col.boolean() } },
      },
    });
    const migrations = defineMigrations([
      {
        toVersion: 2,
        steps: [addColumns('t', { b: col.string().indexed() }), createTable('u', { columns: { x: col.boolean() } })],
      },
    ]);
    const { db } = await openTestDb(v2, { path, migrations });
    await db.write(async tx => {
      await tx.insert('u', { id: 'u1', x: true });
    });
    expect((await db.find('u', 'u1')).x).toBe(true);
    await db.close();
    const names = dumpFile(path).ddl.map(d => d.name);
    expect(names).toEqual(expect.arrayContaining(['t_b', 'u', 'u__status']));
  });

  it('rejects duplicate and invalid migrations', () => {
    expect(() => defineMigrations([{ toVersion: 2, steps: [] }, { toVersion: 2, steps: [] }])).toThrow(/Duplicate/);
    expect(() => defineMigrations([{ toVersion: 1, steps: [] }])).toThrow(/Invalid/);
  });

  it('uses a single driver transaction', async () => {
    const driver = new BetterSqliteDriver({ path: ':memory:' });
    let count = 0;
    const orig = driver.transaction.bind(driver);
    driver.transaction = fn => {
      count += 1;
      return orig(fn);
    };
    const { openDatabase } = await import('../../src');
    await openDatabase({ driver, schema: synclaireSchema('in') });
    expect(count).toBe(1);
  });
});
