import type { FastifyInstance } from 'fastify';

export type RecentThread = { id: string; cwd: string; recencyAt: number | null };

export function registerListRecentThreads(
  app: FastifyInstance,
  deps: { list(): Promise<RecentThread[]> },
): void {
  app.get('/api/sessions/recent-threads', async () => {
    const threads = await deps.list();
    return threads.map(({ id, cwd, recencyAt }) => ({ id, cwd, recencyAt }));
  });
}
