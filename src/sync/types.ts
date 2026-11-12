import type { Database } from '../db/Database';
import type { RawRecord, Schema } from '../schema/defineSchema';

export type DirtyRaw = Record<string, unknown>;

export interface SyncTableChangeSet<R = DirtyRaw> {
  created: R[];
  updated: R[];
  deleted: string[];
}

export type SyncDatabaseChangeSet<R = DirtyRaw> = Record<string, SyncTableChangeSet<R>>;

export interface SyncPullArgs {
  lastPulledAt: number | null;
  schemaVersion: number;
  migration: null;
}

export interface SyncPullResult {
  changes: SyncDatabaseChangeSet;
  timestamp: number;
}

export interface SyncPushArgs {
  changes: SyncDatabaseChangeSet<RawRecord>;
  lastPulledAt: number;
}

export type SyncRejectedIds = Record<string, string[]>;

export interface SyncPushResult {
  experimentalRejectedIds?: SyncRejectedIds;
}

export type SyncConflict =
  | {
      type: 'merge';
      table: string;
      local: RawRecord;
      remote: DirtyRaw;
      resolved: RawRecord;
    }
  | {
      /** The server deleted a record that had unpushed local changes; the local changes are lost. */
      type: 'remoteDelete';
      table: string;
      local: RawRecord;
    };

/** Same fields as WatermelonDB's `SyncLog`. */
export interface SyncLog {
  startedAt?: Date;
  lastPulledAt?: number | null;
  lastPulledSchemaVersion?: number | null;
  migration?: null;
  newLastPulledAt?: number;
  resolvedConflicts?: Array<{ local: DirtyRaw; remote: DirtyRaw; resolved: DirtyRaw }>;
  rejectedIds?: SyncRejectedIds;
  finishedAt?: Date;
  remoteChangeCount?: number;
  localChangeCount?: number;
  phase?: string;
  error?: Error;
}

export interface SyncConsole {
  warn(message: string): void;
  error(message: string): void;
}

export interface SyncArgs<S extends Schema = Schema> {
  database: Database<S>;
  pullChanges: (args: SyncPullArgs) => Promise<SyncPullResult>;
  pushChanges?: (args: SyncPushArgs) => Promise<SyncPushResult | void | undefined>;
  /** Server sends all non-deleted records as `updated`; silences the "doesn't exist locally" warning. */
  sendCreatedAsUpdated?: boolean;
  log?: SyncLog;
  /** Notified (inside the apply transaction) of merges and remote deletes of locally changed rows. */
  onConflict?: (conflict: SyncConflict) => void;
  /** Like WatermelonDB's `conflictResolver`: may return a different resolved raw. */
  conflictResolver?: (table: string, local: RawRecord, remote: DirtyRaw, resolved: DirtyRaw) => DirtyRaw;
  onWillApplyRemoteChanges?: (info: { remoteChangeCount: number }) => Promise<void> | void;
  onDidPullChanges?: (rest: Record<string, unknown>) => void;
  logger?: SyncConsole;
}
