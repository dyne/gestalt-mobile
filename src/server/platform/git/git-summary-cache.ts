/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';

/** Coalesces concurrent inspections without retaining results across refreshes. */
export class GitSummaryCache<T> {
  private readonly inspections = new Map<string, Promise<T>>();

  constructor(private readonly inspectWorkspace: (workspacePath: string) => Promise<T>) {}

  async inspect(workspacePath: string): Promise<T> {
    const key = resolve(workspacePath);
    const pending = this.inspections.get(key);
    if (pending) return pending;
    const inspection = this.inspectWorkspace(workspacePath);
    this.inspections.set(key, inspection);
    try {
      return await inspection;
    } finally {
      if (this.inspections.get(key) === inspection) this.inspections.delete(key);
    }
  }

  invalidate(workspacePath: string): void {
    this.inspections.delete(resolve(workspacePath));
  }
}
