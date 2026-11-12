export class RecordNotFoundError extends Error {
  constructor(readonly table: string, readonly id: string) {
    super(`[synclaire] Record ${table}#${id} not found`);
    this.name = 'RecordNotFoundError';
  }
}

export class TransactionFinishedError extends Error {
  constructor() {
    super(
      '[synclaire] This write transaction has already finished. Make sure every write inside db.write() is awaited.',
    );
    this.name = 'TransactionFinishedError';
  }
}

export class DatabaseResetError extends Error {
  constructor() {
    super('[synclaire] The database was reset while this operation was running');
    this.name = 'DatabaseResetError';
  }
}

export class DeletedRecordError extends Error {
  constructor(readonly table: string, readonly id: string) {
    super(`[synclaire] Record ${table}#${id} is marked as deleted and cannot be updated`);
    this.name = 'DeletedRecordError';
  }
}
