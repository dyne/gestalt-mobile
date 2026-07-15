import { resolve } from 'node:path';

/** Caches successful workspace inspections until a Git mutation invalidates them. */
export class GitSummaryCache<T> {
  private readonly summaries = new Map<string, T>();

  constructor(private readonly inspectWorkspace: (workspacePath: string) => Promise<T>) {}

  async inspect(workspacePath: string): Promise<T> {
    const key = resolve(workspacePath);
    const cached = this.summaries.get(key);
    if (cached !== undefined) return cached;
    const summary = await this.inspectWorkspace(workspacePath);
    this.summaries.set(key, summary);
    return summary;
  }

  invalidate(workspacePath: string): void {
    this.summaries.delete(resolve(workspacePath));
  }
}
