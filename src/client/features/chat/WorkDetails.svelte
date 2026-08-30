<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { HistoryActivity } from './activity-summary.js';
  import { presentActivity, summarizeCommandActivities } from './activity-presentation.js';
  import { summarizeChangedFiles } from './file-change-summary.js';
  import { formatRelativeAge } from './message-time.js';

  let { activities, now = Date.now() }: { activities: readonly HistoryActivity[]; now?: number } =
    $props();

  let commands = $derived(summarizeCommandActivities(activities));
  let failedCommands = $derived(
    activities.flatMap((activity) => {
      const presentation = presentActivity(activity);
      return presentation?.kind === 'Command' && presentation.status === 'failed'
        ? [{ id: activity.id, command: presentation.content }]
        : [];
    }),
  );
  let files = $derived(summarizeChangedFiles(activities));
  let nonCommandActivities = $derived(
    activities.flatMap((activity) => {
      const presentation = presentActivity(activity);
      return presentation && presentation.kind !== 'Command' && presentation.kind !== 'File change'
        ? [{ id: activity.id, ...presentation }]
        : [];
    }),
  );
  let activityCount = $derived(activities.length);
  let summary = $derived(
    `Work details · ${activityCount} ${activityCount === 1 ? 'activity' : 'activities'} · ${commands.successful} successful commands · ${commands.failed} failed commands · ${files.length} ${files.length === 1 ? 'file' : 'files'}`,
  );
</script>

{#if activityCount}
  <details class="work-details">
    <summary>{summary}</summary>
    <div class="work-details-content">
      {#if commands.successful || commands.failed}
        <dl class="command-counts">
          <div>
            <dt>Successful commands</dt>
            <dd>{commands.successful}</dd>
          </div>
          <div>
            <dt>Failed commands</dt>
            <dd>{commands.failed}</dd>
          </div>
        </dl>
      {/if}
      {#if failedCommands.length}
        <section aria-label="Failed commands">
          <strong>Failed commands</strong>
          <ul class="activity-list">
            {#each failedCommands as command (command.id)}
              <li data-status="failed"><code>{command.command}</code></li>
            {/each}
          </ul>
        </section>
      {/if}
      {#if nonCommandActivities.length}
        <ul class="activity-list" aria-label="Work activity">
          {#each nonCommandActivities as activity (activity.id)}
            <li data-status={activity.status}>
              <small>{activity.kind}{activity.status ? ` · ${activity.status}` : ''}</small>
              <span>{activity.content}</span>
            </li>
          {/each}
        </ul>
      {/if}
      {#if files.length}
        <section aria-label="Files changed">
          <strong>Files changed</strong>
          <ul class="file-list">
            {#each files as file (file.path)}
              <li>
                <code>{file.path}</code>
                <span class="file-counts" aria-label="Line changes"
                  ><span>+{file.additions ?? '?'}</span><span>-{file.deletions ?? '?'}</span></span
                >
                {#if file.touchedAt !== undefined}<time
                    datetime={new Date(file.touchedAt).toISOString()}
                    >{formatRelativeAge(file.touchedAt, now)}</time
                  >{:else}<span>time unknown</span>{/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    </div>
  </details>
{/if}

<style>
  .work-details {
    margin-block: 0.35rem;
    min-inline-size: 0;
  }
  summary {
    cursor: pointer;
    color: var(--theme-text-muted);
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  summary:focus-visible {
    outline: 2px solid var(--theme-focus);
    outline-offset: 2px;
  }
  .work-details-content {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
    padding: 0.5rem 0.625rem;
    background: var(--theme-surface-subtle);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }
  .command-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin: 0;
  }
  .command-counts div {
    display: flex;
    gap: 0.35rem;
  }
  dt,
  dd {
    margin: 0;
  }
  dd,
  .file-counts {
    font-family: var(--theme-font-code);
    font-variant-numeric: tabular-nums;
  }
  .activity-list,
  .file-list {
    display: grid;
    gap: 0.35rem;
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
  }
  .activity-list li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    min-inline-size: 0;
  }
  .activity-list small,
  time,
  .file-list > li > span:last-child {
    color: var(--theme-text-muted);
  }
  .activity-list li[data-status='failed'] small {
    color: var(--theme-error);
  }
  .activity-list li span,
  code {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
  .file-list li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 0.35rem 0.65rem;
    align-items: baseline;
  }
  .file-counts {
    display: inline-flex;
    gap: 0.3rem;
    white-space: nowrap;
  }
  .file-counts span:first-child {
    color: var(--theme-success);
  }
  .file-counts span:last-child {
    color: var(--theme-error);
  }
  time,
  .file-list > li > span:last-child {
    font-size: 0.8rem;
    white-space: nowrap;
  }
  @media (max-width: 32rem) {
    .file-list li {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .file-list time,
    .file-list > li > span:last-child {
      grid-column: 2;
    }
  }
</style>
