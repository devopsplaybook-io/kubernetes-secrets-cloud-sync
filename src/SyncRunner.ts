/**
 * Runs a task with single-flight semantics: concurrent calls share the
 * in-flight run instead of starting a second one. A new run can start once
 * the previous one settled, whether it succeeded or failed.
 */
export class SingleFlightRunner<T = void> {
  private inFlight: Promise<T> | null = null;

  constructor(private readonly task: () => Promise<T>) {}

  run(): Promise<T> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const current = Promise.resolve()
      .then(() => this.task())
      .finally(() => {
        if (this.inFlight === current) {
          this.inFlight = null;
        }
      });
    this.inFlight = current;
    return current;
  }

  /**
   * Resolve once the in-flight run settled (or immediately when idle).
   * The run's outcome is ignored: this exists to drain work before shutdown.
   */
  async whenIdle(): Promise<void> {
    const current = this.inFlight;
    if (!current) {
      return;
    }
    try {
      await current;
    } catch {
      // Shutdown must not fail because the drained run failed.
    }
  }
}
