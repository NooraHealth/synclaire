export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  private pending = 0;

  get isLocked(): boolean {
    return this.pending > 0;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      this.pending -= 1;
      release();
    }
  }
}
