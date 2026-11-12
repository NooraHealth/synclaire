import { Q, synchronize, uuidv4 } from 'synclaire';

import { openAppDatabase } from '../openAppDatabase';

export interface BenchResult {
  name: string;
  ms: number;
}

const INSERTS = 2000;
const PULL_SESSIONS = 5000;
const PAGES = 100;
const PAGE_SIZE = 50;

/** On-device timings for the operations the app does most: bulk writes, big pulls, paged lists. */
export async function runBenchmarks(log: (line: string) => void): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  const time = async (name: string, fn: () => Promise<unknown>) => {
    const started = Date.now();
    await fn();
    const ms = Date.now() - started;
    results.push({ name, ms });
    log(`${String(ms).padStart(6)} ms  ${name}`);
  };

  const run = Date.now().toString(36);
  const nurse = uuidv4();
  const classType = uuidv4();

  const local = await openAppDatabase({ code: 'in', name: `bench-local-${run}` });
  await time(`insert ${INSERTS} sessions in one write`, () =>
    local.write(async tx => {
      for (let i = 0; i < INSERTS; i++) {
        await tx.insert('patient_sessions', { date: i, class_type: classType, created_by: nurse, no_of_patients: i % 20 });
      }
    }),
  );
  await local.close();

  const pulled = await openAppDatabase({ code: 'in', name: `bench-pull-${run}` });
  const sessions = Array.from({ length: PULL_SESSIONS }, (_, i) => ({
    id: uuidv4(),
    date: 1_700_000_000_000 + i * 60_000,
    time_slot: 'morning',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    created_by: nurse,
    class_type: classType,
    no_of_patients: i % 20,
    feedback: i % 3 ? null : `feedback ${i}`,
  }));
  const links = sessions.map(s => ({ id: uuidv4(), session_id: s.id, nurse_id: nurse }));
  await time(`apply first pull: ${PULL_SESSIONS} sessions + ${PULL_SESSIONS} links`, () =>
    synchronize({
      database: pulled,
      pullChanges: async () => ({
        changes: {
          patient_sessions: { created: sessions, updated: [], deleted: [] },
          patient_session_nurses: { created: links, updated: [], deleted: [] },
          nurses: { created: [{ id: nurse, name: 'Bench Nurse' }], updated: [], deleted: [] },
        },
        timestamp: Date.now(),
      }),
    }),
  );
  await time(`${PAGES} pages of ${PAGE_SIZE} sessions sorted by date`, async () => {
    for (let p = 0; p < PAGES; p++) {
      await pulled.query('patient_sessions', Q.sortBy('date', 'desc'), Q.take(PAGE_SIZE), Q.skip(p * PAGE_SIZE));
    }
  });
  await time('count sessions joined to a nurse (Q.on)', () =>
    pulled.count('patient_sessions', Q.on('patient_session_nurses', 'nurse_id', nurse)),
  );
  await pulled.close();
  return results;
}
