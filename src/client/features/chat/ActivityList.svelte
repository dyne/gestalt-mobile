<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { HistoryActivity } from './activity-summary.js';
  import { presentActivity, summarizeCommandActivities } from './activity-presentation.js';
  let {
    activities,
    variant = 'summary',
  }: { activities: HistoryActivity[]; variant?: 'live' | 'summary' } = $props();

  let presentedActivities = $derived(
    activities.flatMap((activity) => {
      const presentation = presentActivity(activity);
      return presentation && presentation.kind.toLowerCase().replaceAll(' ', '') !== 'filechange'
        ? [{ id: activity.id, ...presentation }]
        : [];
    }),
  );
  let hasCommands = $derived(presentedActivities.some((activity) => activity.kind === 'Command'));
  let commandSummary = $derived(summarizeCommandActivities(activities));
  let visibleActivities = $derived(
    presentedActivities.filter((activity) => activity.kind !== 'Command'),
  );
</script>

{#snippet commandCounts()}
  <dl class="command-counts">
    <div data-command-outcome="successful">
      <dt>Successful commands</dt>
      <dd>{commandSummary.successful}</dd>
    </div>
    <div data-command-outcome="failed">
      <dt>Failed commands</dt>
      <dd>{commandSummary.failed}</dd>
    </div>
  </dl>
{/snippet}

{#snippet activityRows()}
  {#if visibleActivities.length}
    <ul class="activity-list">
      {#each visibleActivities as activity (activity.id)}
        <li
          class="activity-row"
          data-activity-kind={activity.kind.toLowerCase().replaceAll(' ', '-')}
          data-activity-status={activity.status}
        >
          <small class="activity-type"
            >{activity.kind}{activity.status ? ` · ${activity.status}` : ''}</small
          >
          <span class="activity-content">{activity.content}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#if hasCommands || visibleActivities.length}
  {#if variant === 'summary'}
    <details class="chat-activity">
      <summary>activity</summary>
      {#if hasCommands}{@render commandCounts()}{/if}
      {@render activityRows()}
    </details>
  {:else}
    <section class="live-activity" aria-label="Current activity">
      <strong>activity</strong>
      {#if hasCommands}{@render commandCounts()}{/if}
      {@render activityRows()}
    </section>
  {/if}
{/if}

<style>
  .chat-activity,
  .live-activity {
    --activity-gap: 0.4rem;
    --activity-type-color: var(--theme-text-muted);
  }

  .chat-activity > summary {
    color: var(--activity-type-color);
    font-size: 0.875em;
    cursor: pointer;
  }

  .live-activity {
    margin-block-start: 0.5rem;
  }

  .live-activity > strong {
    color: var(--activity-type-color);
    font-size: 0.875em;
  }

  .activity-list {
    display: grid;
    gap: var(--activity-gap);
    margin-block: 0.25rem 0;
    margin-inline: 0;
    padding: 0;
    list-style: none;
  }

  .command-counts {
    display: grid;
    gap: var(--activity-gap);
    margin-block: 0.25rem 0;
  }

  .command-counts div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    max-inline-size: 20rem;
  }

  .command-counts dt,
  .command-counts dd {
    margin: 0;
  }

  .command-counts dd {
    min-inline-size: 2ch;
    font-family: var(--theme-font-code);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }

  .command-counts [data-command-outcome='successful'] dd {
    color: var(--theme-success);
  }

  .command-counts [data-command-outcome='failed'] dd {
    color: var(--theme-error);
  }

  .activity-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    align-items: baseline;
  }

  .activity-row[data-activity-status='failed'] {
    border-inline-start: 0.25rem solid var(--theme-error);
    padding-inline-start: 0.375rem;
  }
  .activity-row[data-activity-status='completed'] {
    border-inline-start: 0.25rem solid var(--theme-success);
    padding-inline-start: 0.375rem;
  }
  .activity-row[data-activity-status]:not([data-activity-status='completed']):not(
      [data-activity-status='failed']
    ) {
    border-inline-start: 0.25rem solid var(--theme-info);
    padding-inline-start: 0.375rem;
  }

  .activity-type {
    color: var(--activity-type-color);
    font-size: 0.75em;
    line-height: 1.2;
  }

  .activity-content {
    min-inline-size: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
</style>
