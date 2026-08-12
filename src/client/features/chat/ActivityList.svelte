<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { HistoryActivity } from './activity-summary.js';
  import { presentActivity } from './activity-presentation.js';
  let {
    activities,
    variant = 'summary',
  }: { activities: HistoryActivity[]; variant?: 'live' | 'summary' } = $props();

  let visibleActivities = $derived(
    activities.flatMap((activity) => {
      const presentation = presentActivity(activity);
      return presentation && presentation.kind.toLowerCase().replaceAll(' ', '') !== 'filechange'
        ? [{ id: activity.id, ...presentation }]
        : [];
    }),
  );
</script>

{#if visibleActivities.length}
  {#if variant === 'summary'}
    <details class="chat-activity">
      <summary>activity <span aria-hidden="true">· {visibleActivities.length}</span></summary>
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
    </details>
  {:else}
    <section class="live-activity" aria-label="Current activity">
      <strong>activity</strong>
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
