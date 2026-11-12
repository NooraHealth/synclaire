import { describe, expect, it } from 'vitest';

import { compileCount, compileSelect, Q, sanitizeLikeString } from '../../src';
import { inSchema } from '../fixtures/countries';
import { openTestDb } from '../helpers';

const sel = (table: string, ...clauses: Parameters<typeof compileSelect>[2]) => compileSelect(inSchema, table, clauses);

describe('compiler', () => {
  it('excludes deleted rows by default', () => {
    expect(sel('nurses')).toEqual({
      sql: `select "nurses".* from "nurses" where "nurses"."_status" is not 'deleted'`,
      params: [],
    });
    expect(compileSelect(inSchema, 'nurses', [], { includeDeleted: true }).sql).toBe(
      'select "nurses".* from "nurses"',
    );
  });

  it('compiles comparisons with bound parameters', () => {
    const q = sel(
      'patient_sessions',
      Q.where('class_type', 'a'),
      Q.where('feedback', Q.notEq(null)),
      Q.where('date', Q.gt(1)),
      Q.where('date', Q.gte(2)),
      Q.where('date', Q.lt(3)),
      Q.where('date', Q.lte(4)),
      Q.where('no_of_patients', Q.between(1, 9)),
      Q.where('id', Q.oneOf(['x', 'y'])),
      Q.where('id', Q.notIn([])),
      Q.where('location', Q.isNull()),
    );
    expect(q.sql).toBe(
      'select "patient_sessions".* from "patient_sessions" where "patient_sessions"."class_type" is ? and ' +
        '"patient_sessions"."feedback" is not ? and "patient_sessions"."date" > ? and "patient_sessions"."date" >= ? and ' +
        '"patient_sessions"."date" < ? and "patient_sessions"."date" <= ? and ' +
        '"patient_sessions"."no_of_patients" between ? and ? and "patient_sessions"."id" in (?, ?) and ' +
        `"patient_sessions"."id" not in () and "patient_sessions"."location" is ? and "patient_sessions"."_status" is not 'deleted'`,
    );
    expect(q.params).toEqual(['a', null, 1, 2, 3, 4, 1, 9, 'x', 'y', null]);
  });

  it('encodes booleans as 1/0', () => {
    expect(sel('nurses', Q.where('name', true as unknown as string)).params).toEqual([1]);
  });

  it('compiles and/or groups', () => {
    const q = sel('nurses', Q.or(Q.where('name', 'a'), Q.and(Q.where('state', 'b'), Q.where('facility', 'c'))));
    expect(q.sql).toContain(
      '("nurses"."name" is ? or ("nurses"."state" is ? and "nurses"."facility" is ?))',
    );
    expect(sel('nurses', Q.or()).sql).toContain('where 0 and');
  });

  it('sorts, limits and offsets (offset only with limit, take(0) = no limit)', () => {
    expect(sel('patient_sessions', Q.sortBy('date', Q.desc), Q.sortBy('id'), Q.take(10), Q.skip(20)).sql).toMatch(
      /order by "patient_sessions"."date" desc, "patient_sessions"."id" asc limit 10 offset 20$/,
    );
    expect(sel('nurses', Q.skip(5)).sql).not.toContain('offset');
    expect(sel('nurses', Q.take(0)).sql).not.toContain('limit');
    expect(sel('nurses', Q.limit(3), Q.offset(1)).sql).toMatch(/limit 3 offset 1$/);
  });

  it('compiles has_many and belongs_to joins as EXISTS, excluding deleted joined rows', () => {
    const q = sel('patient_sessions', Q.on('patient_session_nurses', 'nurse_id', 'n1'));
    expect(q.sql).toBe(
      'select "patient_sessions".* from "patient_sessions" where exists (select 1 from "patient_session_nurses" where ' +
        '"patient_session_nurses"."session_id" = "patient_sessions"."id" and "patient_session_nurses"."nurse_id" is ? and ' +
        `"patient_session_nurses"."_status" is not 'deleted') and "patient_sessions"."_status" is not 'deleted'`,
    );
    const b = sel('patient_session_nurses', Q.on('nurses', [Q.where('name', 'x')]));
    expect(b.sql).toContain('"nurses"."id" = "patient_session_nurses"."nurse_id"');
    expect(() => sel('nurses', Q.on('patient_sessions', 'date', 1))).toThrow(/No association/);
  });

  it('rejects unknown columns and tables (no injection through identifiers)', () => {
    expect(() => sel('nurses', Q.where('name" or 1=1 --', 'x'))).toThrow(/Unknown column/);
    expect(() => sel('nurses', Q.sortBy('name; drop table nurses'))).toThrow(/Unknown column/);
    expect(() => sel('nope')).toThrow(/Unknown table/);
  });

  it('counts with limit applied', () => {
    expect(compileCount(inSchema, 'nurses', [Q.take(5)]).sql).toBe(
      `select count(*) as "count" from (select "nurses"."id" from "nurses" where "nurses"."_status" is not 'deleted' limit 5)`,
    );
  });

  it('sanitizeLikeString matches WatermelonDB', () => {
    expect(sanitizeLikeString("50%_off' OR 1=1")).toBe('50__off__OR_1_1');
  });
});

describe('query execution', () => {
  async function seeded() {
    const t = await openTestDb(inSchema);
    await t.db.write(async tx => {
      await tx.insert('patient_sessions', { id: 's1', date: 3, feedback: "it's fine" });
      await tx.insert('patient_sessions', { id: 's2', date: 1 });
      await tx.insert('patient_sessions', { id: 's3', date: 2 });
      await tx.insert('nurses', { id: 'n1', name: 'Asha' });
      await tx.insert('patient_session_nurses', { id: 'l1', session_id: 's1', nurse_id: 'n1' });
      await tx.insert('patient_session_nurses', { id: 'l2', session_id: 's2', nurse_id: 'n1' });
    });
    await t.driver.run(`update patient_session_nurses set _status = 'deleted' where id = 'l2'`);
    return t;
  }

  it('treats injection attempts in values as data', async () => {
    const { db } = await seeded();
    expect(await db.query('patient_sessions', Q.where('id', "s1' or '1'='1"))).toEqual([]);
    expect(await db.query('patient_sessions', Q.where('feedback', "it's fine"))).toHaveLength(1);
  });

  it('like with sanitized input', async () => {
    const { db } = await seeded();
    const rows = await db.query('patient_sessions', Q.where('feedback', Q.like(`%${sanitizeLikeString("it's")}%`)));
    expect(rows.map(r => r.id)).toEqual(['s1']);
  });

  it('joins ignore deleted link rows', async () => {
    const { db } = await seeded();
    const rows = await db.query('patient_sessions', Q.on('patient_session_nurses', 'nurse_id', 'n1'));
    expect(rows.map(r => r.id)).toEqual(['s1']);
  });

  it('pages in sort order', async () => {
    const { db } = await seeded();
    const page = await db.query('patient_sessions', Q.sortBy('date', Q.desc), Q.take(2), Q.skip(1));
    expect(page.map(r => r.id)).toEqual(['s3', 's2']);
    expect(await db.count('patient_sessions', Q.where('date', Q.gte(2)))).toBe(2);
  });
});
