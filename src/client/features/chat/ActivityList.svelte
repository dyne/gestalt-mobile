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
</script>

{#if visibleActivities.length}
  <section id="chat-activity" aria-labelledby="activities-title">
    <h3 id="activities-title">Activity</h3>
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
  </section>
{/if}

<style>
  #chat-activity {
    --activity-gap: 0.4rem;
    --activity-type-color: var(--muted-text, currentColor);
  }

  .activity-list {
    display: grid;
    gap: var(--activity-gap);
    margin: 0;
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
