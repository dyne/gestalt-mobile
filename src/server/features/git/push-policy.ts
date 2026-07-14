export function mayPush(input: { upstream: string | null; ahead: number; behind: number }): {
  allowed: boolean;
  reason?: string;
} {
  if (!input.upstream) return { allowed: false, reason: 'NO_UPSTREAM' };
  if (input.ahead < 1) return { allowed: false, reason: 'NOT_AHEAD' };
  if (input.behind > 0) return { allowed: false, reason: 'BEHIND_UPSTREAM' };
  return { allowed: true };
}
