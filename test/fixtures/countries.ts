/**
 * Country schemas for tests: the Synclaire side lives in scenarios/countries.ts (shared with the
 * example app); this adds the WatermelonDB schema/migrations/models built from the same specs.
 */
import { createRequire } from 'node:module';

import { COUNTRY_SPECS, SESSION_NURSES, columnsAtV1, type ColSpec, type CountryCode } from '../../scenarios/countries';

export * from '../../scenarios/countries';


const require = createRequire(import.meta.url);
const wm = require('@nozbe/watermelondb') as typeof import('@nozbe/watermelondb');
const wmMigrations = require('@nozbe/watermelondb/Schema/migrations') as typeof import('@nozbe/watermelondb/Schema/migrations');

function wmTables(sessions: ColSpec[], nurses: ColSpec[]) {
  const ts = (name: string, cols: ColSpec[]) =>
    wm.tableSchema({
      name,
      columns: cols.map(c => ({ name: c.name, type: c.type, ...(c.isOptional ? { isOptional: true } : {}) })),
    });
  return [ts('patient_sessions', sessions), ts('nurses', nurses), ts('patient_session_nurses', SESSION_NURSES)];
}

export function watermelonSchema(code: CountryCode) {
  const spec = COUNTRY_SPECS[code];
  return wm.appSchema({ version: spec.version, tables: wmTables(spec.sessions, spec.nurses) });
}

export function watermelonSchemaV1(code: CountryCode) {
  const spec = COUNTRY_SPECS[code];
  return wm.appSchema({
    version: 1,
    tables: wmTables(columnsAtV1(spec, 'patient_sessions'), columnsAtV1(spec, 'nurses')),
  });
}

export function watermelonMigrations(code: CountryCode) {
  return wmMigrations.schemaMigrations({
    migrations: COUNTRY_SPECS[code].migrations.map(m => ({
      toVersion: m.toVersion,
      steps: [
        wmMigrations.addColumns({
          table: m.table,
          columns: m.columns.map(c => ({ name: c.name, type: c.type, ...(c.isOptional ? { isOptional: true } : {}) })),
        }),
      ],
    })),
  });
}

/** Model classes mirroring shared/db/<country>: Session has `@readonly @date` timestamps. */
export function watermelonModels() {
  class Session extends wm.Model {
    static override table = 'patient_sessions';
    static override associations = { patient_session_nurses: { type: 'has_many' as const, foreignKey: 'session_id' } };
    get createdAt() {
      return this._getRaw('created_at');
    }
    get updatedAt() {
      return this._getRaw('updated_at');
    }
  }
  class Nurse extends wm.Model {
    static override table = 'nurses';
    static override associations = { patient_session_nurses: { type: 'has_many' as const, foreignKey: 'nurse_id' } };
  }
  class SessionNurse extends wm.Model {
    static override table = 'patient_session_nurses';
    static override associations = {
      patient_sessions: { type: 'belongs_to' as const, key: 'session_id' },
      nurses: { type: 'belongs_to' as const, key: 'nurse_id' },
    };
  }
  return [Session, Nurse, SessionNurse];
}
