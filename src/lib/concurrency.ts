/** Runs `worker` over `items` with at most `limit` in flight. Rejects on the first failure. */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
}
