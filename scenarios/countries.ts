/**
 * The four hep-unified-frontend country schemas (shared/db/{in,bd,id,np}), described once and
 * turned into Synclaire schemas and migrations. Platform-neutral: used by the Node tests (which
 * also derive the WatermelonDB oracle from COUNTRY_SPECS) and by the Expo example app.
 */
import { addColumns, col, defineMigrations, defineSchema, type Migrations, type Schema } from '../src';
import type { ColumnBuilder, ColumnType } from '../src/schema/columns';
import type { TableDefinition } from '../src/schema/defineSchema';

export type CountryCode = 'in' | 'bd' | 'id' | 'np';

/** Session count column shared by Synclaire schema and Django for probe S2/S4. */
export function sessionCountColumn(code: CountryCode): 'no_of_patients' | 'no_of_participants' {
  return code === 'id' ? 'no_of_participants' : 'no_of_patients';
}

export interface ColSpec {
  name: string;
  type: ColumnType;
  isOptional?: boolean;
}

export interface CountrySpec {
  version: number;
  sessions: ColSpec[];
  nurses: ColSpec[];
  migrations: { toVersion: number; table: 'patient_sessions' | 'nurses'; columns: ColSpec[] }[];
}

const n = (name: string, isOptional = false): ColSpec => ({ name, type: 'number', isOptional });
const s = (name: string, isOptional = false): ColSpec => ({ name, type: 'string', isOptional });

export const COUNTRY_SPECS: Record<CountryCode, CountrySpec> = {
  in: {
    version: 3,
    sessions: [
      n('date'), s('time_slot'), n('created_at'), n('updated_at'), s('created_by'), s('location', true),
      s('class_type'), n('no_of_participants'), n('no_of_estimated_res_signups'), n('no_of_patients'),
      n('no_of_caregivers'), n('session_photo_count'), s('feedback', true),
    ],
    nurses: [
      s('number'), s('state'), s('name'), s('designation'), s('facility'), s('facility_type'),
      s('condition_area'), n('date_of_tot'), s('account_status'), n('privacy_consent_timestamp', true),
    ],
    migrations: [
      { toVersion: 2, table: 'patient_sessions', columns: [n('no_of_patients'), n('no_of_caregivers'), s('time_slot')] },
      { toVersion: 3, table: 'nurses', columns: [n('privacy_consent_timestamp')] },
    ],
  },
  bd: {
    version: 2,
    sessions: [
      n('date'), n('created_at'), n('updated_at'), s('created_by'), s('location'), s('class_type'),
      n('no_of_caregivers'), n('no_of_male_caregivers'), n('no_of_patients'), n('no_of_estimated_res_signups'),
      n('res_photo_count'), n('session_photo_count'), s('feedback', true),
    ],
    nurses: [
      s('number'), s('name'), s('state'), n('date_of_tot'), n('date_of_birth'), s('designation'), s('facility'),
      s('facility_type'), s('account_status'), n('privacy_consent_timestamp', true),
    ],
    migrations: [{ toVersion: 2, table: 'nurses', columns: [n('privacy_consent_timestamp')] }],
  },
  id: {
    version: 3,
    sessions: [
      n('date'), n('created_at'), n('updated_at'), n('photo_consent_timestamp', true), s('created_by'),
      s('location', true), s('class_type'), s('health_topic'), s('intervention_type'), s('supporting_activity'),
      n('total_no_of_caregivers'), n('no_of_participants'), n('no_of_male_caregivers'), n('no_of_male_participants'),
      n('no_of_anc_mothers'), n('no_of_pnc_mothers'), n('no_of_ncd_patients'), n('no_of_estimated_res_signups'),
      n('res_photo_count'), n('session_photo_count'), s('feedback', true),
    ],
    nurses: [
      s('number'), s('province'), s('name'), n('date_of_birth'), s('designation'), s('facility'), s('facility_type'),
      n('date_of_tot'), s('account_status'), n('privacy_consent_timestamp', true),
    ],
    migrations: [
      {
        toVersion: 2,
        table: 'patient_sessions',
        columns: [
          n('no_of_ncd_patients'), n('no_of_participants'), s('intervention_type'), s('supporting_activity'),
          n('no_of_male_participants'), s('health_topic'),
        ],
      },
      { toVersion: 3, table: 'nurses', columns: [n('privacy_consent_timestamp')] },
    ],
  },
  np: {
    version: 2,
    sessions: [
      n('date'), s('time_slot'), n('created_at'), n('updated_at'), s('created_by'), s('class_type'),
      n('no_of_patients'), n('no_of_caregivers'), n('session_photo_count'), s('feedback', true),
    ],
    nurses: [
      s('number'), s('province'), s('name'), s('designation'), s('facility'), s('facility_type'), s('department'),
      n('date_of_tot'), s('account_status'), n('privacy_consent_timestamp', true),
    ],
    migrations: [{ toVersion: 2, table: 'nurses', columns: [n('privacy_consent_timestamp')] }],
  },
};

export const COUNTRIES = Object.keys(COUNTRY_SPECS) as CountryCode[];

export const SESSION_NURSES: ColSpec[] = [s('session_id'), s('nurse_id')];

function builder(c: ColSpec): ColumnBuilder<ColumnType, boolean> {
  const b = col[c.type]();
  return c.isOptional ? b.optional() : b;
}

function columnsOf(specs: ColSpec[]): Record<string, ColumnBuilder<ColumnType, boolean>> {
  return Object.fromEntries(specs.map(c => [c.name, builder(c)]));
}

/** Columns present at schema version 1 (latest minus everything added by migrations). */
export function columnsAtV1(spec: CountrySpec, table: 'patient_sessions' | 'nurses'): ColSpec[] {
  const added = new Set(spec.migrations.filter(m => m.table === table).flatMap(m => m.columns.map(c => c.name)));
  return (table === 'patient_sessions' ? spec.sessions : spec.nurses).filter(c => !added.has(c.name));
}

function tables(sessions: ColSpec[], nurses: ColSpec[]) {
  return {
    patient_sessions: {
      columns: columnsOf(sessions),
      associations: { patient_session_nurses: { type: 'has_many', foreignKey: 'session_id' } },
      timestamps: true,
    },
    nurses: {
      columns: columnsOf(nurses),
      associations: { patient_session_nurses: { type: 'has_many', foreignKey: 'nurse_id' } },
    },
    patient_session_nurses: {
      columns: columnsOf(SESSION_NURSES),
      associations: {
        patient_sessions: { type: 'belongs_to', key: 'session_id' },
        nurses: { type: 'belongs_to', key: 'nurse_id' },
      },
    },
  } satisfies Record<string, TableDefinition>;
}

export function synclaireSchema(code: CountryCode) {
  const spec = COUNTRY_SPECS[code];
  return defineSchema({ version: spec.version, tables: tables(spec.sessions, spec.nurses) });
}

export function synclaireSchemaV1(code: CountryCode): Schema {
  const spec = COUNTRY_SPECS[code];
  return defineSchema({
    version: 1,
    tables: tables(columnsAtV1(spec, 'patient_sessions'), columnsAtV1(spec, 'nurses')),
  });
}

export function synclaireMigrations(code: CountryCode): Migrations {
  return defineMigrations(
    COUNTRY_SPECS[code].migrations.map(m => ({
      toVersion: m.toVersion,
      steps: [addColumns(m.table, columnsOf(m.columns))],
    })),
  );
}

/** India schema type, used where tests want static row types. */
export const inSchema = synclaireSchema('in');
export type InSchema = typeof inSchema;
