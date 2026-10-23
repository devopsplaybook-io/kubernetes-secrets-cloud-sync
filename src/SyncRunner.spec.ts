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
});
