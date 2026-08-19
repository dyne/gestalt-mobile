<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import type { AgentActivitySnapshot, AgentActivityState } from './contracts.js';
  import { activityAnnouncement } from './announcement-policy.js';
  let { activity }: { activity: AgentActivitySnapshot | null } = $props();
  const labels: Record<AgentActivityState, string> = {
    working: 'working',
    idle: 'idle',
    awaitingAgent: 'waiting for child',
    awaitingHuman: 'needs you',
    blocked: 'blocked',
    disconnected: 'disconnected',
  };
  let announcement = $state('');
  let critical = $state('');
  let previousActivity: AgentActivitySnapshot | null = null;
  let category = $derived(
    activity ? `${activity.sessionId}:${activity.root.state}:${activity.aggregateSubagents}` : '',
  );
  $effect(() => {
    if (!category) return;
    const next = untrack(() => activity);
    const previous = untrack(() => previousActivity);
    if (!next) return;
    const transition = activityAnnouncement(
      previous?.sessionId === next.sessionId ? previous : null,
      next,
    );
    if (transition.polite) announcement = transition.polite;
    if (transition.critical) critical = transition.critical;
    else if (next.root.state !== 'blocked' && next.root.state !== 'awaitingHuman') critical = '';
    previousActivity = next;
  });
</script>

<section class="agent-activity" aria-label="Agent activity">
  {#if activity}
    <div class="chips">
      <span class="chip" data-state={activity.root.state}
        ><span aria-hidden="true">●</span> Supervisor: {labels[activity.root.state]}</span
      >
      <details class="children">
        <summary class="chip" data-state={activity.aggregateSubagents}
          ><span aria-hidden="true">◆</span> Subagents: {labels[activity.aggregateSubagents]} ({activity
            .subagents.length})</summary
        >
        <ul>
          {#each activity.subagents as child (child.id)}
            <li>
              <strong>{child.nickname ?? child.id}</strong>{child.role ? ` · ${child.role}` : ''} — {labels[
                child.state
              ]} <small>{child.lastActivityAt}</small>
            </li>
          {/each}
        </ul>
      </details>
      <span class="freshness"
        >{activity.confidence === 'fresh'
          ? 'Current'
          : activity.confidence === 'reconciling'
            ? 'Checking updates'
            : 'May be stale'}</span
      >
    </div>
    <p class="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>
    {#if critical}<p class="visually-hidden" role="alert">{critical}</p>{/if}
  {/if}
</section>

<style>
  .agent-activity {
    max-inline-size: 100%;
    overflow-wrap: anywhere;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    min-inline-size: 0;
  }
  .chip,
  .freshness {
    border: 1px solid var(--theme-border);
    border-radius: 999px;
    padding: 0.35rem 0.55rem;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .children > summary {
    cursor: pointer;
    min-block-size: 2.75rem;
    display: inline-flex;
    align-items: center;
  }
  .children ul {
    margin: 0.45rem 0 0;
    padding-inline-start: 1.25rem;
    max-inline-size: min(38rem, 100%);
  }
  .children small {
    color: var(--theme-text-muted);
  }
  [data-state='blocked'],
  [data-state='awaitingHuman'],
  [data-state='disconnected'] {
    font-weight: 700;
    text-decoration: underline;
  }
  .visually-hidden {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  summary:focus-visible {
    outline: 3px solid var(--theme-accent);
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
