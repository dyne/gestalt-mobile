<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { fetchAge } from './fetch-age.js';
  import { relativeTime } from './relative-time.js';
  import type { RelayGitSummary } from '../sessions/relay-client.js';
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import FilesystemTree from '../filesystem-tree/FilesystemTree.svelte';

  type Props = {
    workspaceTree: WorkspaceOption[];
    selectedWorkspace: WorkspaceOption | null;
    expandedIds: ReadonlySet<string>;
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
    onselect: (node: WorkspaceOption) => void;
    onexpandedchange: (expandedIds: Set<string>) => void;
    onclone: (address: string) => void;
  };

  let {
    workspaceTree,
    selectedWorkspace,
    expandedIds,
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
    onselect,
    onexpandedchange,
    onclone,
  }: Props = $props();
  let cloneAddress = $state('');
  let cloneDestination = $derived(
    selectedWorkspace && !selectedWorkspace.isGitRepository ? selectedWorkspace : null,
  );

  function submitClone(event: SubmitEvent): void {
    event.preventDefault();
    if (!cloneAddress.trim() || cloning) return;
    onclone(cloneAddress.trim());
  }
</script>

<section class="git-view" aria-labelledby="git-title">
  <h2 id="git-title" class="visually-hidden">Git</h2>
  <section class="git-tree" aria-labelledby="git-tree-title">
    <div class="section-heading">
      <h3 id="git-tree-title">Repository and clone destination</h3>
      <p>Select any folder. Git repositories enable repository actions; other folders are clone destinations.</p>
    </div>
    <FilesystemTree
      roots={workspaceTree}
      {expandedIds}
      selectedId={selectedWorkspace?.id ?? null}
      label="Git repository and clone destination"
      {onexpandedchange}
      {onselect}
    />
  </section>
  <form class="clone-form" onsubmit={submitClone}>
    <div class="clone-controls">
      <div class="clone-field clone-destination">
        <span class="field-label">Destination</span>
        <output aria-live="polite">
          {cloneDestination ? `~/${cloneDestination.relativePath}` : 'Select a non-repository folder'}
        </output>
      </div>
      <div class="clone-field">
        <label for="git-clone-address">Git address</label>
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
      </div>
      <button type="submit" disabled={cloning}
        >{cloning ? 'Cloning…' : 'Clone'}</button
      >
    </div>
    <p id="clone-help">The repository is cloned inside the selected workspace.</p>
    {#if cloneStatus}<p class="clone-status" role="status">{cloneStatus}</p>{/if}
  </form>
  <section class="repository-details" aria-labelledby="repository-details-title">
    <h3 id="repository-details-title">Repository details</h3>
    {#if selectedWorkspace?.isGitRepository}
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
      {:else if !error}
        <p role="status">Loading repository status…</p>
      {/if}
    {:else if selectedWorkspace}
      <p>
        <strong>{selectedWorkspace.name}</strong> is available as a Clone destination. Select a Git
        repository to inspect branches and enable repository actions.
      </p>
      <div class="git-actions" aria-label="Repository actions unavailable">
        <button type="button" disabled><span aria-hidden="true">↑</span> Push</button>
        <button type="button" disabled><span aria-hidden="true">↓</span> Pull</button>
      </div>
    {:else}
      <p>Select a folder above to choose a Clone destination or inspect a Git repository.</p>
      <div class="git-actions" aria-label="Repository actions unavailable">
        <button type="button" disabled><span aria-hidden="true">↑</span> Push</button>
        <button type="button" disabled><span aria-hidden="true">↓</span> Pull</button>
      </div>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
</section>

<style>
  .git-view {
    display: grid;
    gap: 1.5rem;
    inline-size: 100%;
    min-inline-size: 0;
  }
  .git-tree,
  .repository-details {
    min-inline-size: 0;
  }
  .section-heading h3,
  .repository-details h3 {
    margin-block: 0 0.35rem;
  }
  .section-heading p {
    margin-block: 0 0.75rem;
    color: color-mix(in srgb, CanvasText 70%, Canvas);
  }
  .clone-form {
    display: grid;
    gap: 0.35rem;
    min-inline-size: 0;
  }
  .clone-controls {
    display: grid;
    grid-template-columns: minmax(10rem, 0.45fr) minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: end;
  }
  .clone-field {
    display: grid;
    min-inline-size: 0;
    gap: 0.35rem;
  }
  .field-label {
    font-weight: 600;
  }
  .clone-destination output {
    min-block-size: 2.75rem;
    padding: 0.65rem 0.75rem;
    overflow-wrap: anywhere;
    border: 1px solid color-mix(in srgb, CanvasText 35%, Canvas);
    border-radius: 0.35rem;
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
    min-inline-size: 0;
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
    flex-wrap: wrap;
    justify-content: space-between;
    color: color-mix(in srgb, CanvasText 70%, Canvas);
    font-size: 0.875rem;
  }
  .commit-meta time {
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-wrap: anywhere;
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
