import { createRequire } from 'node:module';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { col, defineSchema, encodeSchema, type Row } from '../../src';
import { COUNTRIES, inSchema, synclaireSchema, watermelonSchema } from '../fixtures/countries';
import { dumpFile, openTestDb, readFixture, type DbDump } from '../helpers';

const require = createRequire(import.meta.url);
const { encodeSchema: wmEncodeSchema } = require('@nozbe/watermelondb/adapters/sqlite/encodeSchema') as {
  encodeSchema: (schema: unknown) => string;
};

describe('defineSchema', () => {
  it('builds table schemas in declaration order', () => {
    const s = defineSchema({
      version: 2,
      tables: { t: { columns: { a: col.string(), b: col.number().optional().indexed() } } },
    });
    expect(s.tableNames).toEqual(['t']);
    expect(s.tables.t!.columns).toEqual([
      { name: 'a', type: 'string', isOptional: false, isIndexed: false },
      { name: 'b', type: 'number', isOptional: true, isIndexed: true },
    ]);
  });

  it('rejects reserved and invalid names', () => {
    expect(() => defineSchema({ version: 1, tables: { t: { columns: { _status: col.string() } } } })).toThrow(
      /reserved/,
    );
    expect(() => defineSchema({ version: 1, tables: { 't"x': { columns: {} } } })).toThrow(/Invalid table/);
    expect(() => defineSchema({ version: 1, tables: { local_storage: { columns: {} } } })).toThrow(/reserved/);
    expect(() => defineSchema({ version: 0, tables: {} })).toThrow(/version/);
    expect(() =>
      defineSchema({
        version: 1,
        tables: { t: { columns: {}, associations: { u: { type: 'belongs_to', key: 'u_id' } } } },
      }),
    ).toThrow(/does not exist/);
  });

  it('infers row types', () => {
    const schema = defineSchema({
      version: 1,
      tables: {
        patient_sessions: {
          columns: { date: col.number(), class_type: col.string(), feedback: col.string().optional(), done: col.boolean() },
        },
      },
    });
    type Session = Row<typeof schema, 'patient_sessions'>;
    expectTypeOf<Session['feedback']>().toEqualTypeOf<string | null>();
    expectTypeOf<Session['date']>().toEqualTypeOf<number>();
    expectTypeOf<Session['class_type']>().toEqualTypeOf<string>();
    expectTypeOf<Session['done']>().toEqualTypeOf<boolean>();
    expectTypeOf<Session['id']>().toEqualTypeOf<string>();
    expectTypeOf<Session['syncStatus']>().toEqualTypeOf<'synced' | 'created' | 'updated' | 'deleted'>();
    expect(schema.version).toBe(1);
    expect(inSchema.version).toBe(3);
  });
});

describe('DDL', () => {
  it('matches the DDL WatermelonDB wrote in the probe (golden)', async () => {
    const golden = readFixture<DbDump>('05-db-after-s2.json');
    const { path, driver } = await openTestDb(inSchema);
    await driver.close();
    const dump = dumpFile(path);
    expect(dump.ddl).toEqual(golden.ddl);
    expect(dump.user_version).toBe(golden.user_version);
  });

  it.each(COUNTRIES)('generates the same SQL as WatermelonDB encodeSchema (%s)', code => {
    expect(encodeSchema(synclaireSchema(code))).toBe(wmEncodeSchema(watermelonSchema(code)));
  });

  it('matches WatermelonDB for indexed and optional columns', () => {
    const wm = require('@nozbe/watermelondb') as typeof import('@nozbe/watermelondb');
    const ours = defineSchema({
      version: 1,
      tables: {
        a: { columns: { x: col.string().indexed(), y: col.boolean().optional(), z: col.number() } },
        b: { columns: {} },
      },
    });
    const theirs = wm.appSchema({
      version: 1,
      tables: [
        wm.tableSchema({
          name: 'a',
          columns: [
            { name: 'x', type: 'string', isIndexed: true },
            { name: 'y', type: 'boolean', isOptional: true },
            { name: 'z', type: 'number' },
          ],
        }),
        wm.tableSchema({ name: 'b', columns: [] }),
      ],
    });
    expect(encodeSchema(ours)).toBe(wmEncodeSchema(theirs));
  });
});
