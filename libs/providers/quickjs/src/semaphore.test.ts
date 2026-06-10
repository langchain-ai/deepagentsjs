import { describe, it, expect } from "vitest";
import { Semaphore } from "./semaphore.js";

describe("Semaphore", () => {
  it("throws when constructed with less than 1 permit", () => {
    expect(() => new Semaphore(0)).toThrow(
      "Semaphore requires at least 1 permit",
    );
    expect(() => new Semaphore(-1)).toThrow(
      "Semaphore requires at least 1 permit",
    );
  });

  it("reports initial available and waiting counts", () => {
    const sem = new Semaphore(3);
    expect(sem.available).toBe(3);
    expect(sem.waiting).toBe(0);
  });

  it("acquire resolves immediately when permits are available", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    expect(sem.available).toBe(1);
    await sem.acquire();
    expect(sem.available).toBe(0);
  });

  it("release returns a permit to the pool", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    expect(sem.available).toBe(0);
    sem.release();
    expect(sem.available).toBe(1);
  });

  it("queues callers when all permits are taken", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    let queued = false;
    const pending = sem.acquire().then(() => {
      queued = true;
    });

    // Queued caller should not have resolved yet
    await Promise.resolve();
    expect(queued).toBe(false);
    expect(sem.waiting).toBe(1);

    sem.release();
    await pending;
    expect(queued).toBe(true);
    expect(sem.waiting).toBe(0);
  });

  it("unblocks waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));
    const p3 = sem.acquire().then(() => order.push(3));

    expect(sem.waiting).toBe(3);

    sem.release();
    await p1;
    sem.release();
    await p2;
    sem.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it("supports concurrent work gated by permit count", async () => {
    const sem = new Semaphore(3);
    let running = 0;
    let maxRunning = 0;

    async function task(): Promise<void> {
      await sem.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      sem.release();
    }

    await Promise.all(Array.from({ length: 10 }, () => task()));

    expect(maxRunning).toBe(3);
    expect(sem.available).toBe(3);
    expect(sem.waiting).toBe(0);
  });

  it("returns permits correctly after all waiters drain", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();

    const p1 = sem.acquire();
    sem.release();
    await p1;

    sem.release();
    sem.release();
    expect(sem.available).toBe(2);
    expect(sem.waiting).toBe(0);
  });
});
