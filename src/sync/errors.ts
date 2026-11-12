export class SyncError extends Error {
  constructor(message: string) {
    super(`[Sync] ${message}`);
    this.name = 'SyncError';
  }
}

export class SyncAlreadyRunningError extends SyncError {
  constructor() {
    super('Another synchronize() call is already running on this database');
    this.name = 'SyncAlreadyRunningError';
  }
}

export class SyncDatabaseResetError extends SyncError {
  constructor() {
    super('Sync aborted because database was reset');
    this.name = 'SyncDatabaseResetError';
  }
}

export class ConcurrentSyncError extends SyncError {
  constructor() {
    super(
      'Concurrent synchronization is not allowed. More than one synchronize() call was running at the same time, and the later one was aborted before committing results to local database.',
    );
    this.name = 'ConcurrentSyncError';
  }
}

export class InvalidPullError extends SyncError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPullError';
  }
}
