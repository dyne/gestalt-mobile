export async function mapWithConcurrency<T>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (index < values.length) {
        const value = values[index++];
        if (value !== undefined) await task(value);
      }
    }),
  );
}
