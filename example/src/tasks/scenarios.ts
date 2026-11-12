import { runProbeScenarios, type ScenarioResult } from '../../../scenarios/probe';
import { synclaireSchema } from '../../../scenarios/countries';
import { apiUrl, control, type Backend } from '../host';
import { openAppDatabase } from '../openAppDatabase';

/** The same S1–S8 steps the Node integration suite runs, on device storage via expo-sqlite. */
export async function runScenarios(backend: Backend, log: (line: string) => void): Promise<ScenarioResult[]> {
  const run = Date.now().toString(36);
  return runProbeScenarios(
    {
      baseUrl: apiUrl(backend),
      seed: backend.seed,
      log,
      openDatabase: (name, now) => openAppDatabase({ code: backend.code, name: `scenario-${run}-${name}`, now }),
      control: (action, uuid) => control(backend, action, uuid),
    },
    synclaireSchema(backend.code).version,
  );
}
