import { mapWithConcurrency } from "./Concurrency";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapWithConcurrency", () => {
  it("returns an empty array for empty input", async () => {
    const fn = jest.fn();
    await expect(mapWithConcurrency([], 4, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("handles a limit larger than the input length", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 10, async (item) => {
      return item * 2;
    });
    expect(result).toEqual([2, 4, 6]);
  });

  it("preserves the input order", async () => {
    const delays = [30, 1, 20, 2, 10];
    const result = await mapWithConcurrency(delays, 3, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending = new Map<number, ReturnType<typeof deferred<void>>>();

    const run = mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferred<void>();
      pending.set(item, gate);
      await gate.promise;
      inFlight--;
      return item;
    });

    // Let the first two workers start.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(inFlight).toBe(2);

    let resolved = 0;
    while (resolved < 6) {
      for (const [item, gate] of pending) {
        if (resolved === item) {
          gate.resolve();
          resolved++;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await expect(run).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(2);
  });

  it("rejects when the mapped function throws", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) {
          throw new Error("boom");
        }
        return item;
      }),
    ).rejects.toThrow("boom");
  });

  it("clamps a non-positive concurrency to one", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return item;
    });
    expect(maxInFlight).toBe(1);
  });
});
