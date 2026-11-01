/**
 * Map `items` through `fn` with at most `concurrency` calls in flight.
 * Results keep the input order. The first rejection is propagated; callers
 * that need per-item isolation must catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const results: R[] = Array.from(
    { length: items.length },
    () => undefined as R,
  );
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  };

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
