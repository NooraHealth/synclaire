import type { SyncLog } from './types';

/** Keeps the most recent sync logs, like WatermelonDB's `SyncLogger`. */
export class SyncLogger {
  private readonly entries: SyncLog[] = [];

  constructor(private readonly limit = 10) {}

  newLog(): SyncLog {
    if (this.entries.length >= this.limit) this.entries.shift();
    const log: SyncLog = {};
    this.entries.push(log);
    return log;
  }

  get logs(): readonly SyncLog[] {
    return [...this.entries];
  }

  get formattedLogs(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}
