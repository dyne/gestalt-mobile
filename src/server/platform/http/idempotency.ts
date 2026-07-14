export type IdempotentResponse = { statusCode: number; body: string };
export function idempotencyKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers['idempotency-key'];
  return typeof value === 'string' && value.trim() ? value : null;
}
