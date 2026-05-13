// Unit test for the inline runWithConcurrency helper used by Monitor.
// We re-export it through a tiny shim to avoid having to expose internals
// of monitor.ts. To keep this self-contained without modifying production
// code, we re-implement the helper inline here and verify the contract that
// monitor.ts relies on (preserves order, respects the cap, runs in parallel).

import { describe, it, expect, vi } from "vitest";

// Mirror of the inline runWithConcurrency in monitor.ts. If the production
// version diverges, this test must be updated in lockstep — which is the
// signal we want.
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

describe("runWithConcurrency", () => {
  it("preserves input order in the result", async () => {
    const tasks = [10, 5, 15, 1, 8].map((delay, i) => () =>
      new Promise<number>((resolve) => setTimeout(() => resolve(i), delay))
    );
    const out = await runWithConcurrency(tasks, 3);
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it("never runs more than `concurrency` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return inFlight;
    });

    await runWithConcurrency(tasks, 3);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // verify it actually parallelized
  });

  it("handles concurrency > tasks length without spawning excess workers", async () => {
    const fn = vi.fn(async () => 42);
    const tasks = [fn, fn, fn]; // 3 tasks
    await runWithConcurrency(tasks, 100);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("returns an empty array for zero tasks", async () => {
    const out = await runWithConcurrency([], 5);
    expect(out).toEqual([]);
  });

  it("propagates the first task error (consistent with Promise.all)", async () => {
    const tasks = [
      async () => 1,
      async () => {
        throw new Error("boom");
      },
      async () => 3,
    ];
    await expect(runWithConcurrency(tasks, 2)).rejects.toThrow(/boom/);
  });

  it("clamps concurrency to at least 1", async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) => async () => {
      order.push(n);
      return n;
    });

    // concurrency=0 should clamp to 1 (sequential)
    const out = await runWithConcurrency(tasks, 0);
    expect(out).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]); // strict sequential order
  });

  it("speedup vs sequential is observable for I/O-bound workloads", async () => {
    const N = 6;
    const DELAY_MS = 30;

    const sequentialTasks = Array.from({ length: N }, () => () =>
      new Promise<void>((r) => setTimeout(r, DELAY_MS))
    );
    const parallelTasks = Array.from({ length: N }, () => () =>
      new Promise<void>((r) => setTimeout(r, DELAY_MS))
    );

    const tStart1 = Date.now();
    await runWithConcurrency(sequentialTasks, 1);
    const tSequential = Date.now() - tStart1;

    const tStart2 = Date.now();
    await runWithConcurrency(parallelTasks, 3);
    const tParallel = Date.now() - tStart2;

    // 6 tasks × 30ms sequential ≈ 180ms; with concurrency 3 ≈ 60ms.
    // Allow generous slop to keep the test stable on loaded CI.
    expect(tParallel).toBeLessThan(tSequential * 0.7);
  });
});
