export type { Driver, SqlExecutor, SqlRow, SqlValue, RunResult } from './driver/types';

export { col, ColumnBuilder } from './schema/columns';
export type { ColumnType, ColumnSchema } from './schema/columns';
export { defineSchema } from './schema/defineSchema';
export type {
  Association,
  InsertValues,
  RawRecord,
  Row,
  Schema,
  SyncStatus,
  TableDefinition,
  TableName,
  TableSchema,
  UpdateValues,
} from './schema/defineSchema';
export { encodeSchema } from './schema/ddl';

export {
  addColumns,
  createTable,
  defineMigrations,
  unsafeExecuteSql,
  MigrationPathError,
  SchemaTooNewError,
} from './migrations';
export type { Migration, MigrationStep, Migrations, SetupResult } from './migrations';

export { Database, openDatabase } from './db/Database';
export type { ChangeListener, LocalStorage, OpenDatabaseOptions } from './db/Database';
export { WriteTx } from './db/WriteTx';
export { DeletedRecordError, RecordNotFoundError, TransactionFinishedError } from './db/errors';

export { Q, sanitizeLikeString } from './query/Q';
export type { Clause, Comparison, Condition, Value } from './query/Q';
export { compileCount, compileSelect } from './query/compile';

export { synchronize, hasUnsyncedChanges, fetchLocalChanges } from './sync/synchronize';
export { SyncLogger } from './sync/SyncLogger';
export {
  ConcurrentSyncError,
  InvalidPullError,
  SyncAlreadyRunningError,
  SyncDatabaseResetError,
  SyncError,
} from './sync/errors';
export type {
  DirtyRaw,
  SyncArgs,
  SyncConflict,
  SyncConsole,
  SyncDatabaseChangeSet,
  SyncLog,
  SyncPullArgs,
  SyncPullResult,
  SyncPushArgs,
  SyncPushResult,
  SyncRejectedIds,
  SyncTableChangeSet,
} from './sync/types';
export { uuidv4 } from './utils/id';
