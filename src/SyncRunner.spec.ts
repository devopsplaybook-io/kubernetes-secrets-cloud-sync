import { SingleFlightRunner } from "./SyncRunner";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SingleFlightRunner", () => {
  it("runs the task once for two concurrent calls", async () => {
    const gate = deferred();
    const task = jest.fn(async () => {
      await gate.promise;
    });
    const runner = new SingleFlightRunner(task);

    const first = runner.run();
    const second = runner.run();
    expect(second).toBe(first);

    gate.resolve();
    await Promise.all([first, second]);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("starts a new run after the previous one completed", async () => {
    const task = jest.fn(async () => {});
    const runner = new SingleFlightRunner(task);

    await runner.run();
    await runner.run();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight state when the task rejects", async () => {
    const task = jest
      .fn<Promise<void>, []>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const runner = new SingleFlightRunner(task);

    await expect(runner.run()).rejects.toThrow("boom");
    await expect(runner.run()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("returns the same rejected promise to concurrent callers", async () => {
    const gate = deferred();
    const task = jest.fn(async () => {
      await gate.promise;
      throw new Error("boom");
    });
    const runner = new SingleFlightRunner(task);

    const first = runner.run();
    const second = runner.run();
    gate.resolve();

    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("returns the task result to every caller", async () => {
    const runner = new SingleFlightRunner(async () => 42);

    await expect(runner.run()).resolves.toBe(42);
  });

  it("reports whether a run is in flight", async () => {
    const gate = deferred();
    const runner = new SingleFlightRunner(async () => {
      await gate.promise;
    });

    expect(runner.isRunning()).toBe(false);
    const running = runner.run();
    expect(runner.isRunning()).toBe(true);

    gate.resolve();
    await running;
    expect(runner.isRunning()).toBe(false);
  });

  it("reports not running after a rejected run", async () => {
    const runner = new SingleFlightRunner(async () => {
      throw new Error("boom");
    });

    await expect(runner.run()).rejects.toThrow("boom");
    expect(runner.isRunning()).toBe(false);
  });

  it("whenIdle resolves immediately when no run is in flight", async () => {
    const runner = new SingleFlightRunner(async () => undefined);

    await expect(runner.whenIdle()).resolves.toBeUndefined();
  });

  it("whenIdle waits for the in-flight run", async () => {
    const gate = deferred();
    const runner = new SingleFlightRunner(async () => {
      await gate.promise;
    });

    let idle = false;
    const running = runner.run();
    const idlePromise = runner.whenIdle().then(() => {
      idle = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(idle).toBe(false);

    gate.resolve();
    await idlePromise;
    await running;
    expect(idle).toBe(true);
  });

  it("whenIdle swallows a rejected in-flight run", async () => {
    const gate = deferred();
    const runner = new SingleFlightRunner(async () => {
      await gate.promise;
      throw new Error("boom");
    });

    const running = runner.run();
    const idlePromise = runner.whenIdle();
    gate.resolve();

    await expect(idlePromise).resolves.toBeUndefined();
    await expect(running).rejects.toThrow("boom");
  });
});
