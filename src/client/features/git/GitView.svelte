<script lang="ts">
  import { fetchAge } from './fetch-age.js';
  import type { RelayGitSummary } from '../sessions/relay-client.js';

  type Props = {
    sessionId: string | null;
    summary: RelayGitSummary | null;
    refreshing: boolean;
    checkingOut: boolean;
    error: string | null;
    confirmingPush: boolean;
    onpull: () => void;
    oncheckout: (branch: string) => void;
    onopenpushconfirmation: () => void;
    onpush: () => void;
    oncancelpush: () => void;
  };

  let { sessionId, summary, refreshing, checkingOut, error, confirmingPush, onpull, oncheckout, onopenpushconfirmation, onpush, oncancelpush }: Props = $props();
</script>

<section aria-labelledby="git-title">
  <h2 id="git-title" class="visually-hidden">Git</h2>
  {#if sessionId}
    {#if summary}
      {#if summary.available}
        <div class="git-overview">
          <div class="git-status">
            <label for="git-branch">Branch</label>
            <select id="git-branch" value={summary.branch ?? ''} disabled={refreshing || checkingOut || !(summary.branches?.length)} onchange={(event) => oncheckout(event.currentTarget.value)}>
              {#each summary.branches ?? [] as branch (branch)}
                <option value={branch}>{branch}</option>
              {/each}
            </select>
            <p>Upstream: {summary.upstream ?? 'none'}</p>
            <p>Ahead {summary.ahead}; behind {summary.behind}.</p>
            <p><time datetime={summary.fetchedAt ?? undefined}>{fetchAge(summary.fetchedAt)}</time></p>
            <p>Changes: {summary.dirty.staged} staged, {summary.dirty.unstaged} unstaged, {summary.dirty.untracked} untracked.</p>
          </div>
          <div class="git-actions">
            <button type="button" disabled={refreshing || checkingOut || !summary.upstream || summary.ahead < 1 || summary.behind > 0} onclick={onopenpushconfirmation}><span aria-hidden="true">↑</span> Push</button>
            <button type="button" disabled={refreshing || checkingOut} onclick={onpull}><span aria-hidden="true">↓</span> {refreshing ? 'Pulling…' : 'Pull'}</button>
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
          <h3>Recent commits</h3>
          <ol aria-label="Recent commits">
            {#each summary.commits as commit (commit.hash)}
              <li><code>{commit.shortHash}</code> {commit.subject} — {commit.author}<time datetime={commit.authoredAt}> {commit.authoredAt}</time></li>
            {/each}
          </ol>
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
  .git-overview { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: start; }
  .git-status p { margin-block: 0.5rem; }
  .git-actions { display: grid; gap: 0.5rem; }
  .git-actions button { min-inline-size: 6rem; }
</style>
