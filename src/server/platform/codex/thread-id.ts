export function requireThreadId(threadId: string | null): string {
  if (!threadId) throw new Error('THREAD_REQUIRED');
  return threadId;
}
