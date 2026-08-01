<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { HistoryActivity } from './activity-summary.js';
  import { presentActivity } from './activity-presentation.js';
  let { activities }: { activities: HistoryActivity[] } = $props();

  let visibleActivities = $derived(
    activities.flatMap((activity) => {
      const presentation = presentActivity(activity);
      return presentation ? [{ id: activity.id, ...presentation }] : [];
    }),
  );
  let hasInProgressActivity = $derived(
    visibleActivities.some(
      (activity) => activity.status !== 'completed' && activity.status !== 'failed',
    ),
  );
</script>

{#if visibleActivities.length}
  <details id="chat-activity" open={hasInProgressActivity}>
    <summary>activity</summary>
    <ul class="activity-list">
    {#each visibleActivities as activity (activity.id)}
      <li
        class="activity-row"
        data-activity-kind={activity.kind.toLowerCase().replaceAll(' ', '-')}
        data-activity-status={activity.status}
      >
        <small class="activity-type">{activity.kind}{activity.status ? ` · ${activity.status}` : ''}</small>
        <span class="activity-content">{activity.content}</span>
      </li>
    {/each}
    </ul>
  </details>
{/if}

<style>
  #chat-activity {
    --activity-gap: 0.4rem;
    --activity-type-color: var(--muted-text, currentColor);
  }

  #chat-activity > summary {
    color: var(--activity-type-color);
    font-size: 0.875em;
    cursor: pointer;
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
