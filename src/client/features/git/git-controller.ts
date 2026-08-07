/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelayGitSummary } from '../sessions/relay-client.js';

export type GitState = Readonly<{
  workspaceId: string | null;
  summary: RelayGitSummary | null;
  loading: boolean;
  refreshing: boolean;
  checkingOut: boolean;
  error: string | null;
}>;

export type GitTransport = Readonly<{
  getSummary(workspaceId: string, signal: AbortSignal): Promise<RelayGitSummary>;
  pull(workspaceId: string, key: string, signal: AbortSignal): Promise<void>;
  checkout(workspaceId: string, branch: string, signal: AbortSignal): Promise<void>;
}>;

/** Owns git request generations; a result can only update its selected repository. */
export class GitController {
  #state: GitState = {
    workspaceId: null,
    summary: null,
    loading: false,
    refreshing: false,
    checkingOut: false,
    error: null,
  };
  #generation = 0;
  #request: AbortController | null = null;
  #disposed = false;

  constructor(
    private readonly transport: GitTransport,
    private readonly isRepository: (workspaceId: string) => boolean,
    private readonly onChange: (state: GitState) => void,
    private readonly errorMessage: (
      error: unknown,
      code: 'GIT_SUMMARY_FAILED' | 'GIT_PULL_FAILED' | 'GIT_CHECKOUT_FAILED',
    ) => string,
  ) {}

  get state(): GitState {
    return this.#state;
  }

  select(workspaceId: string | null): void {
    this.#abort();
    const selected = workspaceId;
    const repository = Boolean(selected && this.isRepository(selected));
    this.#publish({
      workspaceId: selected,
      summary: null,
      loading: repository,
      refreshing: false,
      checkingOut: false,
      error: null,
    });
    if (repository) void this.refresh();
  }

  async refresh(): Promise<void> {
    const workspaceId = this.#state.workspaceId;
    if (!workspaceId || !this.isRepository(workspaceId)) return;
    const request = this.#begin();
    const generation = this.#generation;
    this.#publish({ ...this.#state, loading: true, error: null });
    try {
      const summary = await this.transport.getSummary(workspaceId, request.signal);
      if (this.#current(generation, workspaceId, request))
        this.#publish({ ...this.#state, summary, loading: false });
    } catch (error) {
      if (this.#current(generation, workspaceId, request) && !request.signal.aborted)
        this.#publish({
          ...this.#state,
          summary: null,
          loading: false,
          error: this.errorMessage(error, 'GIT_SUMMARY_FAILED'),
        });
    }
  }

  async pull(key: string): Promise<void> {
    const workspaceId = this.#state.workspaceId;
    if (!workspaceId || this.#state.refreshing) return;
    const request = this.#begin();
    const generation = this.#generation;
    this.#publish({ ...this.#state, refreshing: true, error: null });
    try {
      await this.transport.pull(workspaceId, key, request.signal);
      if (this.#current(generation, workspaceId, request)) {
        this.#publish({ ...this.#state, refreshing: false });
        await this.refresh();
      }
    } catch (error) {
      if (this.#current(generation, workspaceId, request) && !request.signal.aborted)
        this.#publish({
          ...this.#state,
          refreshing: false,
          error: this.errorMessage(error, 'GIT_PULL_FAILED'),
        });
    }
  }

  async checkout(branch: string): Promise<void> {
    const workspaceId = this.#state.workspaceId;
    if (!workspaceId || this.#state.checkingOut || branch === this.#state.summary?.branch) return;
    const request = this.#begin();
    const generation = this.#generation;
    this.#publish({ ...this.#state, checkingOut: true, error: null });
    try {
      await this.transport.checkout(workspaceId, branch, request.signal);
      if (this.#current(generation, workspaceId, request)) {
        this.#publish({ ...this.#state, checkingOut: false });
        await this.refresh();
      }
    } catch (error) {
      if (this.#current(generation, workspaceId, request) && !request.signal.aborted)
        this.#publish({
          ...this.#state,
          checkingOut: false,
          error: this.errorMessage(error, 'GIT_CHECKOUT_FAILED'),
        });
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#abort();
  }
  #begin(): AbortController {
    this.#abort();
    this.#request = new AbortController();
    ++this.#generation;
    return this.#request;
  }
  #abort(): void {
    this.#request?.abort();
    this.#request = null;
    ++this.#generation;
  }
  #current(generation: number, workspaceId: string, request: AbortController): boolean {
    return (
      !this.#disposed &&
      generation === this.#generation &&
      this.#state.workspaceId === workspaceId &&
      this.#request === request
    );
  }
  #publish(state: GitState): void {
    if (!this.#disposed) {
      this.#state = state;
      this.onChange(state);
    }
  }
}
