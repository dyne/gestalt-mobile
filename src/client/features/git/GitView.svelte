<script lang="ts">
  import { fetchAge } from './fetch-age.js';
  import type { RelayGitSummary } from '../sessions/relay-client.js';

  type Props = {
    sessionId: string | null;
    summary: RelayGitSummary | null;
    refreshing: boolean;
    error: string | null;
    confirmingPush: boolean;
    onload: () => void;
    onrefresh: () => void;
    onopenpushconfirmation: () => void;
    onpush: () => void;
    oncancelpush: () => void;
  };

  let { sessionId, summary, refreshing, error, confirmingPush, onload, onrefresh, onopenpushconfirmation, onpush, oncancelpush }: Props = $props();
</script>

<section aria-labelledby="git-title">
  <h2 id="git-title">Git</h2>
  {#if sessionId}
    <button type="button" onclick={onload}>Load status</button>
    {#if summary}
      {#if summary.available}
        <p>Branch: {summary.branch ?? 'detached'} · upstream: {summary.upstream ?? 'none'}</p>
        <p>Ahead {summary.ahead}; behind {summary.behind}.</p>
        <p><time datetime={summary.fetchedAt ?? undefined}>{fetchAge(summary.fetchedAt)}</time></p>
        <p>Changes: {summary.dirty.staged} staged, {summary.dirty.unstaged} unstaged, {summary.dirty.untracked} untracked.</p>
        <button type="button" disabled={refreshing} onclick={onrefresh}>{refreshing ? 'Fetching…' : 'Fetch'}</button>
        {#if error}<p role="alert">{error}</p>{/if}
        <button type="button" disabled={!summary.upstream || summary.ahead < 1 || summary.behind > 0} onclick={onopenpushconfirmation}>Push</button>
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
