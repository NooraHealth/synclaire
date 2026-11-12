/**
 * The subset of expo-sqlite's API Synclaire uses. Kept structural so the core never imports
 * expo-sqlite, and so the driver can be exercised in Node against a fake.
 */
export type ExpoBindValue = string | number | null | Uint8Array;

export interface ExpoSQLiteExecutorLike {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: ExpoBindValue[]): Promise<{ changes: number }>;
  getAllAsync<T>(source: string, params: ExpoBindValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: ExpoBindValue[]): Promise<T | null>;
}

export interface ExpoSQLiteDatabaseLike extends ExpoSQLiteExecutorLike {
  readonly databasePath: string;
  withExclusiveTransactionAsync(task: (txn: ExpoSQLiteExecutorLike) => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

export interface ExpoSQLiteModuleLike {
  openDatabaseAsync(
    databaseName: string,
    options?: Record<string, unknown>,
    directory?: string,
  ): Promise<ExpoSQLiteDatabaseLike>;
  deleteDatabaseAsync(databaseName: string, directory?: string): Promise<void>;
}
