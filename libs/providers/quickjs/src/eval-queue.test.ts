import { describe, it, expect } from "vitest";
import { AsyncEvalQueue } from "./eval-queue.js";

describe("AsyncEvalQueue", () => {
  it("serializes concurrent operations", async () => {
    const queue = new AsyncEvalQueue();
    const log: string[] = [];

    const a = queue.enqueue(async () => {
      log.push("a:start");
      await new Promise((r) => setTimeout(r, 20));
      log.push("a:end");
    });

    const b = queue.enqueue(async () => {
      log.push("b:start");
      await new Promise((r) => setTimeout(r, 10));
      log.push("b:end");
    });

    const c = queue.enqueue(async () => {
      log.push("c:start");
      log.push("c:end");
    });

    await Promise.all([a, b, c]);

    expect(log).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("returns the value from each enqueued operation", async () => {
    const queue = new AsyncEvalQueue();

    const [a, b, c] = await Promise.all([
      queue.enqueue(async () => 1),
      queue.enqueue(async () => "two"),
      queue.enqueue(async () => ({ n: 3 })),
    ]);

    expect(a).toBe(1);
    expect(b).toBe("two");
    expect(c).toEqual({ n: 3 });
  });

  it("continues after a rejected operation", async () => {
    const queue = new AsyncEvalQueue();

    const failing = queue.enqueue(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    const result = await queue.enqueue(async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("preserves insertion order", async () => {
    const queue = new AsyncEvalQueue();
    const order: number[] = [];

    const ops = Array.from({ length: 10 }, (_, i) =>
      queue.enqueue(async () => {
        order.push(i);
      }),
    );

    await Promise.all(ops);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
