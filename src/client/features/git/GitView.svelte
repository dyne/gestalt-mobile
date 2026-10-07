<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { pushState } from './push-state.js';
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
    pushing?: boolean;
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
    onbrowsefiles: (trigger: HTMLButtonElement) => void;
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
    pushing = false,
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
    onbrowsefiles,
    onclone,
  }: Props = $props();
  let cloneAddress = $state('');
  let cloneDestination = $derived(
    selectedWorkspace && !selectedWorkspace.isGitRepository ? selectedWorkspace : null,
  );

  let repositorySelected = $derived(Boolean(selectedWorkspace?.isGitRepository));
  let displayedAddress = $derived(repositorySelected ? (summary?.originUrl ?? '') : cloneAddress);
  let pushAvailability = $derived(summary ? pushState(summary) : { enabled: false, reason: null });

  function submitClone(event: SubmitEvent): void {
    event.preventDefault();
    if (!cloneDestination || !cloneAddress.trim() || cloning) return;
    onclone(cloneAddress.trim());
  }
</script>

<section class="git-view" aria-labelledby="git-title">
  <h2 id="git-title" class="visually-hidden">Git</h2>
  <section class="git-tree" aria-labelledby="git-tree-title">
    <div class="section-heading">
      <h3 id="git-tree-title">Repository and clone destination</h3>
      <p>
        Select any folder. Git repositories enable repository actions; other folders are clone
        destinations.
      </p>
    </div>
    <FilesystemTree
      roots={workspaceTree}
      {expandedIds}
      selectedId={selectedWorkspace?.id ?? null}
      label="Git repository and clone destination"
      {onexpandedchange}
      {onselect}
    />
    <button
      id="browse-files"
      type="button"
      disabled={!selectedWorkspace}
      onclick={(event) => onbrowsefiles(event.currentTarget)}>Browse files</button
    >
  </section>
  <form class="clone-form" onsubmit={submitClone}>
    <div class="clone-controls">
      <div class="clone-field">
        <label for="git-clone-address">Git address</label>
        <input
          id="git-clone-address"
          name="address"
          value={displayedAddress}
          oninput={(event) => (cloneAddress = event.currentTarget.value)}
          readonly={repositorySelected}
          required={!repositorySelected}
          autocomplete="url"
          inputmode="url"
          enterkeyhint="done"
          placeholder={repositorySelected
            ? 'No origin remote'
            : 'https://example.com/owner/repository.git'}
          aria-describedby="clone-help"
        />
      </div>
      <button type="submit" disabled={cloning || !cloneDestination || !cloneAddress.trim()}
        >{cloning ? 'Cloning…' : 'Clone'}</button
      >
    </div>
    <p id="clone-help">
      {repositorySelected
        ? summary?.originUrl
          ? 'Origin remote. Select a folder to clone another repository.'
          : 'No origin remote is configured for this repository.'
        : selectedWorkspace
          ? `Clone into ${selectedWorkspace.name}.`
          : 'Select a folder to clone a repository.'}
    </p>
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
              <p>Upstream: {summary.upstream ?? 'not configured'}</p>
              {#if summary.upstream}<p>Ahead {summary.ahead}; behind {summary.behind}.</p>{/if}
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
                disabled={refreshing || checkingOut || pushing || !pushAvailability.enabled}
                aria-describedby={!pushAvailability.enabled ? 'git-push-help' : undefined}
                onclick={onopenpushconfirmation}><span aria-hidden="true">↑</span> Push</button
              >
              <button
                type="button"
                disabled={refreshing || checkingOut || pushing || !summary.upstream}
                onclick={onpull}
                ><span aria-hidden="true">↓</span> {refreshing ? 'Pulling…' : 'Pull'}</button
              >
              {#if !pushAvailability.enabled && pushAvailability.reason}<p
                  id="git-push-help"
                  class="action-help"
                >
                  {pushAvailability.reason}
                </p>{/if}
            </div>
          </div>
          {#if confirmingPush}
            <section aria-label="Confirm push">
              <p>
                {summary.upstream
                  ? `Push ${summary.branch ?? 'HEAD'} to ${summary.upstream}?`
                  : `Publish ${summary.branch} to origin and set its upstream?`}
              </p>
              <button type="button" disabled={pushing} onclick={onpush}
                >{pushing ? 'Pushing…' : 'Confirm push'}</button
              >
              <button type="button" disabled={pushing} onclick={oncancelpush}>Cancel</button>
            </section>
          {/if}
          {#if summary.commits.length}
            <section class="commit-history" aria-labelledby="recent-commits-title">
              <h3 id="recent-commits-title">Recent commits</h3>
              <ol class="commit-list" aria-label="Recent commits">
                {#each summary.commits as commit (commit.hash)}
                  <li class="commit-entry">
                    <div class="commit-subject">
                      <code title={commit.hash}>{commit.shortHash}</code><span
                        >{commit.subject}</span
                      >
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
        <strong>{selectedWorkspace.name}</strong> is available as a Clone destination. Select a Git repository
        to inspect branches and enable repository actions.
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
    color: var(--theme-text-muted);
  }
  #browse-files {
    inline-size: 100%;
    min-block-size: 3.5rem;
    margin-block-start: 0.75rem;
    font-size: 1rem;
    font-weight: 600;
  }
  .action-help {
    margin: 0;
    max-inline-size: 18ch;
    font-size: 0.8rem;
    color: var(--theme-text-muted);
  }
  .clone-form {
    display: grid;
    gap: 0.35rem;
    min-inline-size: 0;
  }
  .clone-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: end;
  }
  .clone-field {
    display: grid;
    min-inline-size: 0;
    gap: 0.35rem;
  }
  .clone-field label {
    font-weight: 600;
  }
  .clone-controls button {
    min-inline-size: 5.75rem;
  }
  .clone-form p {
    margin: 0;
    color: var(--theme-text-muted);
    font-size: 0.875rem;
  }
  .clone-status {
    color: var(--theme-info) !important;
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
    border-block-end: 1px solid var(--theme-border);
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
    color: var(--theme-text-muted);
    font-size: 0.875em;
  }
  .commit-meta {
    flex-wrap: wrap;
    justify-content: space-between;
    color: var(--theme-text-muted);
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
