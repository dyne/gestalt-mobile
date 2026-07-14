export const recoveryDelays = [500, 2000, 5000] as const;
export function recoveryDelay(failureCount: number): number | null {
  return recoveryDelays[failureCount] ?? null;
}
