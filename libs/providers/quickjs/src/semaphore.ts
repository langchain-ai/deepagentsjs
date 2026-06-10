/**
 * Promise-based counting semaphore for managing concurrent access.
 *
 * When all permits are taken, callers queue and resolve in FIFO order
 * as permits are released — no caller is rejected.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param permits - Maximum number of concurrent holders.
   */
  constructor(permits: number) {
    if (permits < 1) {
      throw new Error("Semaphore requires at least 1 permit");
    }
    this.permits = permits;
  }

  /**
   * Acquire a permit. Resolves immediately if one is available,
   * otherwise queues until a permit is released.
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Release a permit. If callers are queued, the next one is
   * unblocked in FIFO order. Otherwise the permit is returned
   * to the pool.
   */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  /** Number of permits currently available. */
  get available(): number {
    return this.permits;
  }

  /** Number of callers currently waiting for a permit. */
  get waiting(): number {
    return this.waiters.length;
  }
}
