export function mayFetch(lastFetchedAt: number | null, now: number, throttleMs = 60_000): boolean {
  return lastFetchedAt === null || now - lastFetchedAt >= throttleMs;
}
