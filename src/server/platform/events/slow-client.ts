export const slowClientLimitBytes = 1024 * 1024;
export function isSlowClient(bufferedBytes: number): boolean {
  return bufferedBytes > slowClientLimitBytes;
}
