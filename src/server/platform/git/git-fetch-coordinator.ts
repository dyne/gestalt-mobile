/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';

export class GitFetchCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly lastSuccessfulFetch = new Map<string, number>();

  constructor(
    private readonly fetchWorkspace: (workspacePath: string) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly throttleMs = 60_000,
  ) {}

  lastSuccessfulAt(workspacePath: string): number | null {
    return this.lastSuccessfulFetch.get(resolve(workspacePath)) ?? null;
  }

  refresh(workspacePath: string): Promise<void> {
    const key = resolve(workspacePath);
    const active = this.inFlight.get(key);
    if (active) return active;

    const lastFetchedAt = this.lastSuccessfulFetch.get(key);
    if (lastFetchedAt !== undefined && this.now() - lastFetchedAt < this.throttleMs) {
      return Promise.resolve();
    }

    const refresh = this.fetchWorkspace(workspacePath)
      .then(() => {
        this.lastSuccessfulFetch.set(key, this.now());
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, refresh);
    return refresh;
  }
}
