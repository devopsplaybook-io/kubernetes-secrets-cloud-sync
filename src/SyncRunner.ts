/**
 * Runs a task with single-flight semantics: concurrent calls share the
 * in-flight run instead of starting a second one. A new run can start once
 * the previous one settled, whether it succeeded or failed.
 */
export class SingleFlightRunner {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
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
}
