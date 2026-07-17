<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { fetchAge } from './fetch-age.js';
  import { relativeTime } from './relative-time.js';
  import type { RelayGitSummary } from '../sessions/relay-client.js';

  type Props = {
    sessionId: string | null;
    summary: RelayGitSummary | null;
    refreshing: boolean;
    checkingOut: boolean;
    cloning: boolean;
    error: string | null;
    cloneStatus: string | null;
    confirmingPush: boolean;
    onpull: () => void;
    oncheckout: (branch: string) => void;
    onopenpushconfirmation: () => void;
    onpush: () => void;
    oncancelpush: () => void;
    onclone: (address: string) => void;
  };

  let {
    sessionId,
    summary,
    refreshing,
    checkingOut,
    cloning,
    error,
    cloneStatus,
    confirmingPush,
    onpull,
    oncheckout,
    onopenpushconfirmation,
    onpush,
    oncancelpush,
    onclone,
  }: Props = $props();
  let cloneAddress = $state('');

  function submitClone(event: SubmitEvent): void {
    event.preventDefault();
    if (!cloneAddress.trim() || cloning) return;
    onclone(cloneAddress.trim());
  }
</script>

<section class="git-view" aria-labelledby="git-title">
  <h2 id="git-title" class="visually-hidden">Git</h2>
  <form class="clone-form" onsubmit={submitClone}>
    <label for="git-clone-address">Clone repository</label>
    <div class="clone-controls">
      <input
        id="git-clone-address"
        name="address"
        bind:value={cloneAddress}
        required
        autocomplete="url"
        inputmode="url"
        enterkeyhint="done"
        placeholder="https://example.com/owner/repository.git"
        aria-describedby="clone-help"
      />
      <button type="submit" disabled={cloning}>{cloning ? 'Cloning…' : 'Clone'}</button>
    </div>
    <p id="clone-help">
      The repository is cloned into the workspace root as a new first-level folder.
    </p>
    {#if cloneStatus}<p class="clone-status" role="status">{cloneStatus}</p>{/if}
  </form>
  {#if sessionId}
    {#if summary}
      {#if summary.available}
        <div class="git-overview">
          <div class="git-status">
            <label for="git-branch">Branch</label>
            <select
              id="git-branch"
              value={summary.branch ?? ''}
              disabled={refreshing || checkingOut || !summary.branches?.length}
              onchange={(event) => oncheckout(event.currentTarget.value)}
            >
              {#each summary.branches ?? [] as branch (branch)}
                <option value={branch}>{branch}</option>
              {/each}
            </select>
            <p>Upstream: {summary.upstream ?? 'none'}</p>
            <p>Ahead {summary.ahead}; behind {summary.behind}.</p>
            <p>
              <time datetime={summary.fetchedAt ?? undefined}>{fetchAge(summary.fetchedAt)}</time>
            </p>
            <p>
              Changes: {summary.dirty.staged} staged, {summary.dirty.unstaged} unstaged, {summary
                .dirty.untracked} untracked.
            </p>
          </div>
          <div class="git-actions">
            <button
              type="button"
              disabled={refreshing ||
                checkingOut ||
                !summary.upstream ||
                summary.ahead < 1 ||
                summary.behind > 0}
              onclick={onopenpushconfirmation}><span aria-hidden="true">↑</span> Push</button
            >
            <button type="button" disabled={refreshing || checkingOut} onclick={onpull}
              ><span aria-hidden="true">↓</span> {refreshing ? 'Pulling…' : 'Pull'}</button
            >
          </div>
        </div>
        {#if error}<p role="alert">{error}</p>{/if}
        {#if confirmingPush}
          <section aria-label="Confirm push">
            <p>Push HEAD to {summary.upstream}?</p>
            <button type="button" onclick={onpush}>Confirm push</button>
            <button type="button" onclick={oncancelpush}>Cancel</button>
          </section>
        {/if}
        {#if summary.commits.length}
          <section class="commit-history" aria-labelledby="recent-commits-title">
            <h3 id="recent-commits-title">Recent commits</h3>
            <ol class="commit-list" aria-label="Recent commits">
              {#each summary.commits as commit (commit.hash)}
                <li class="commit-entry">
                  <div class="commit-subject">
                    <code title={commit.hash}>{commit.shortHash}</code><span>{commit.subject}</span>
                  </div>
                  <div class="commit-meta">
                    <span>{commit.author}</span><time
                      datetime={commit.authoredAt}
                      title={commit.authoredAt}>{relativeTime(commit.authoredAt)}</time
                    >
                  </div>
                </li>
              {/each}
            </ol>
          </section>
        {/if}
      {:else}
        <p>This workspace is not a Git repository.</p>
      {/if}
    {/if}
  {:else}
    <p>Select a session to view its workspace status.</p>
  {/if}
</section>

<style>
  .git-view {
    inline-size: 100%;
  }
  .clone-form {
    display: grid;
    gap: 0.35rem;
    margin-block-end: 1.5rem;
  }
  .clone-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: end;
  }
  .clone-controls button {
    min-inline-size: 5.75rem;
  }
  .clone-form p {
    margin: 0;
    color: color-mix(in srgb, CanvasText 70%, Canvas);
    font-size: 0.875rem;
  }
  .clone-status {
    color: CanvasText !important;
    font-weight: 600;
  }
  .git-overview {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 1rem;
    align-items: start;
  }
  .git-status p {
    margin-block: 0.5rem;
  }
  .git-actions {
    display: grid;
    gap: 0.5rem;
  }
  .git-actions button {
    min-inline-size: 6rem;
  }
  .commit-history {
    margin-block-start: 2rem;
  }
  .commit-history h3 {
    margin-block-end: 0.75rem;
  }
  .commit-list {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .commit-entry {
    display: grid;
    gap: 0.35rem;
    padding: 0.8rem 0;
    border-block-end: 1px solid color-mix(in srgb, CanvasText 20%, Canvas);
  }
  .commit-subject,
  .commit-meta {
    display: flex;
    min-inline-size: 0;
    gap: 0.65rem;
  }
  .commit-subject {
    align-items: baseline;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .commit-subject code {
    flex: 0 0 auto;
    color: color-mix(in srgb, CanvasText 75%, Canvas);
    font-size: 0.875em;
  }
  .commit-meta {
    justify-content: space-between;
    color: color-mix(in srgb, CanvasText 70%, Canvas);
    font-size: 0.875rem;
  }
  .commit-meta time {
    flex: 0 0 auto;
  }
  @media (max-width: 28rem) {
    .clone-controls {
      grid-template-columns: 1fr;
    }
    .clone-controls button {
      inline-size: 100%;
    }
  }
</style>
