/**
 * Minimal AsyncLocalStorage shim for browsers.
 * LangGraph uses AsyncLocalStorage for context propagation.
 * In a single-threaded browser tab, a simple stack-based implementation works.
 */
export class AsyncLocalStorage<T> {
  private _store: T | undefined;

  getStore(): T | undefined {
    return this._store;
  }

  run<R>(store: T, callback: () => R): R {
    const prev = this._store;
    this._store = store;
    try {
      return callback();
    } finally {
      this._store = prev;
    }
  }

  enterWith(store: T): void {
    this._store = store;
  }

  disable(): void {
    this._store = undefined;
  }
}
