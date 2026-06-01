import { describe, it, expect } from "vitest";
import { SubagentWarmGate, type WarmGateClock } from "./subagentWarmGate.js";

class FakeClock implements WarmGateClock {
  t = 0;
  slept: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.slept.push(ms);
  }
}

const WARM = 10_000;
const TTL = 240_000;

describe("SubagentWarmGate", () => {
  it("lets the first dispatch of a cold type through immediately (it's the warmer)", async () => {
    const clock = new FakeClock();
    const gate = new SubagentWarmGate(WARM, TTL, clock);

    await gate.gate("coder");

    expect(clock.slept).toEqual([]);
  });

  it("holds a concurrent sibling for the full warm window", async () => {
    const clock = new FakeClock();
    const gate = new SubagentWarmGate(WARM, TTL, clock);

    await gate.gate("coder"); // warmer, t=0
    await gate.gate("coder"); // sibling, same instant

    expect(clock.slept).toEqual([WARM]);
  });

  it("holds later siblings only for the remaining window", async () => {
    const clock = new FakeClock();
    const gate = new SubagentWarmGate(WARM, TTL, clock);

    await gate.gate("coder"); // warmer at t=0
    clock.t = 4_000;
    await gate.gate("coder"); // 4s in → wait the remaining 6s

    expect(clock.slept).toEqual([6_000]);
  });

  it("does not wait once the warm window has elapsed (prefix already cached)", async () => {
    const clock = new FakeClock();
    const gate = new SubagentWarmGate(WARM, TTL, clock);

    await gate.gate("coder"); // warmer at t=0
    clock.t = WARM + 1; // past the warm window, within TTL
    await gate.gate("coder");

    expect(clock.slept).toEqual([]);
  });

  it("re-warms a type that has gone cold past the cache TTL", async () => {
    const clock = new FakeClock();
    const gate = new SubagentWarmGate(WARM, TTL, clock);

    await gate.gate("coder"); // warmer at t=0
    clock.t = TTL + 1; // cache expired → cold again
    await gate.gate("coder"); // becomes the new warmer, immediate
    await gate.gate("coder"); // its sibling waits the full window again

    expect(clock.slept).toEqual([WARM]);
  });

  it("keys independently by subagent type", async () => {
    const clock = new FakeClock();
    const gate = new SubagentWarmGate(WARM, TTL, clock);

    await gate.gate("coder"); // warmer for coder
    await gate.gate("template-selector"); // distinct type → its own warmer, immediate

    expect(clock.slept).toEqual([]);
  });
});
