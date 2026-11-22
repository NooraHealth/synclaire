/**
 * Opt-in: `npm run test:backend` (starts Docker Postgres + Django via scripts/backend-up.sh).
 * Runs the shared probe scenarios (scenarios/probe.ts) with Synclaire clients against the real
 * hep-unified-backend; the expected outcomes are the ones WatermelonDB produced there.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sessionCountColumn } from '../../scenarios/countries';
import { controlSql, runProbeScenarios, type BackendSeed, type ControlAction } from '../../scenarios/probe';
import { openDatabase, type Schema } from '../../src';
import { BetterSqliteDriver } from '../../src/testing';
import { synclaireMigrations, synclaireSchema, type CountryCode } from '../fixtures/countries';
import { tmpDbPath } from '../helpers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(HERE, '.state');

interface State {
  country: string;
  baseUrl: string;
  database: string;
  container: string;
  seed: BackendSeed;
}

const COUNTRY_CODES: Record<string, CountryCode> = { india: 'in', nepal: 'np', bangladesh: 'bd', indonesia: 'id' };

function loadStates(): [string, State][] {
  if (!fs.existsSync(STATE_DIR)) return [];
  return fs
    .readdirSync(STATE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => [f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')) as State]);
}

const states = loadStates();
if (!states.length) {
  console.warn('[integration] no backend state found; run `npm run test:backend`');
}

describe.skipIf(!states.length).each(states)('real backend: %s', (key, state) => {
  const code = COUNTRY_CODES[key]!;
  const schema = synclaireSchema(code);

  it('passes the probe scenarios with two nurses', { timeout: 120_000 }, async () => {
    const lines: string[] = [];
    const countColumn = sessionCountColumn(code);
    const results = await runProbeScenarios(
      {
        baseUrl: state.baseUrl,
        seed: state.seed,
        countColumn,
        log: line => lines.push(line),
        openDatabase: (name, now) =>
          openDatabase({
            driver: new BetterSqliteDriver({ path: tmpDbPath(`it-${code}-${name}`) }),
            schema: schema as Schema,
            migrations: synclaireMigrations(code),
            now,
          }),
        control: async (action: ControlAction, uuid: string) =>
          execFileSync('docker', [
            'exec',
            state.container,
            'psql',
            '-U',
            'postgres',
            '-d',
            state.database,
            '-tAc',
            controlSql(action, uuid, countColumn),
          ])
            .toString()
            .trim(),
      },
      schema.version,
    );
    expect(results.filter(r => !r.ok), lines.join('\n')).toEqual([]);
    expect(results).toHaveLength(8);
  });
});
