/**
 * Serializes async operations on a shared WASM module.
 *
 * The quickjs-emscripten asyncify variant allows only one concurrent
 * async call per module instance. This queue enforces that constraint
 * by chaining operations into a promise queue — each caller waits for
 * the previous one to finish before executing.
 */
export class AsyncEvalQueue {
  private tail = Promise.resolve();

  /**
   * Enqueue an async operation. The operation will not start until all
   * previously enqueued operations have completed.
   */
  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const prev = this.tail;
    this.tail = gate;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }
}
