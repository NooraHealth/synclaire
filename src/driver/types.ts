export type SqlValue = string | number | null | Uint8Array;

export type SqlRow = Record<string, SqlValue>;

export interface RunResult {
  changes: number;
}

/** Statement executor. Inside a transaction, use the executor passed to the callback. */
export interface SqlExecutor {
  /** Executes one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  all<T = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
}

export interface Driver extends SqlExecutor {
  readonly name: string;
  /**
   * Runs `fn` in an exclusive transaction. Transactions never interleave: a second call waits
   * for the first to commit or roll back. Statements issued through the main executor while a
   * transaction is open must not be relied upon to see or join that transaction.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /** Closes the connection and removes the database file(s). */
  deleteDatabase(): Promise<void>;
}
