import type { PullResponse, SyncServer, Values } from './harness';

const TABLES = ['patient_sessions', 'nurses', 'patient_session_nurses'] as const;

interface ServerRow {
  data: Values;
  updatedAt: number;
  deleted: boolean;
}

/**
 * A small deterministic stand-in for the Django SyncView:
 * - pull returns every changed row as `updated` (sendCreatedAsUpdated), plus an unknown table
 * - push is atomic and fails with a 400 if an updated row changed on the server after lastPulledAt
 */
export class ModelServer implements SyncServer {
  private time = 1000;
  private readonly rows = new Map<string, Map<string, ServerRow>>(TABLES.map(t => [t, new Map()]));
  failNextPush = false;
  /** What the last pull returned, for coverage statistics. */
  lastPull: { deleted: [string, string][]; updated: [string, string][] } = { deleted: [], updated: [] };
  /** Runs during the next push, before the server responds (e.g. a local edit racing the push). */
  duringPush?: () => Promise<void>;

  upsert(table: string, id: string, values: Values): void {
    const t = this.rows.get(table)!;
    const prev = t.get(id);
    t.set(id, { data: { ...(prev && !prev.deleted ? prev.data : {}), ...values, id }, updatedAt: ++this.time, deleted: false });
  }

  delete(table: string, id: string): void {
    const row = this.rows.get(table)!.get(id);
    if (row && !row.deleted) {
      row.deleted = true;
      row.updatedAt = ++this.time;
    }
  }

  async pull(lastPulledAt: number | null): Promise<PullResponse> {
    const since = lastPulledAt ?? 0;
    const changes: PullResponse['changes'] = {};
    for (const table of TABLES) {
      const updated: Values[] = [];
      const deleted: string[] = [];
      for (const [id, row] of this.rows.get(table)!) {
        if (row.updatedAt <= since) continue;
        if (row.deleted) {
          if (lastPulledAt !== null) deleted.push(id);
        } else {
          updated.push({ ...row.data, server_only_column: 'x' });
        }
      }
      changes[table] = { created: [], updated, deleted };
    }
    this.lastPull = {
      deleted: TABLES.flatMap(t => changes[t]!.deleted.map(id => [t, id] as [string, string])),
      updated: TABLES.flatMap(t => changes[t]!.updated.map(r => [t, r.id as string] as [string, string])),
    };
    changes.patients = { created: [], updated: [{ id: 'p1', name: 'ignored' }], deleted: [] };
    return { changes, timestamp: ++this.time };
  }

  async push(changes: unknown, lastPulledAt: number): Promise<void> {
    if (this.duringPush) {
      const fn = this.duringPush;
      this.duringPush = undefined;
      await fn();
    }
    if (this.failNextPush) {
      this.failNextPush = false;
      throw new Error('push 500');
    }
    const c = changes as Record<string, { created: Values[]; updated: Values[]; deleted: string[] }>;
    for (const table of TABLES) {
      if (!c[table]) throw new Error(`push 400: missing ${table}`);
      for (const raw of c[table].updated) {
        const row = this.rows.get(table)!.get(raw.id as string);
        if (row && row.updatedAt > lastPulledAt) throw new Error(`push 400: ${table} modified after last_pulled_at`);
      }
    }
    for (const table of TABLES) {
      for (const raw of [...c[table]!.created, ...c[table]!.updated]) {
        const { _status, _changed, ...data } = raw;
        void _status;
        void _changed;
        this.upsert(table, data.id as string, data);
      }
      for (const id of c[table]!.deleted) this.delete(table, id);
    }
  }
}
