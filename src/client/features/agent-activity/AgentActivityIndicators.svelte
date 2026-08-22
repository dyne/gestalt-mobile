<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { AgentActivitySnapshot, AgentActivityState } from './contracts.js';
  import { activityAnnouncement } from './announcement-policy.js';
  import { compactElapsedTime } from './relative-activity-time.js';
  let { activity, compact = false }: { activity: AgentActivitySnapshot | null; compact?: boolean } =
    $props();
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
  let now = $state(Date.now());
  let category = $derived(
    activity ? `${activity.sessionId}:${activity.root.state}:${activity.aggregateSubagents}` : '',
  );
  let compactState = $derived(
    activity && ['blocked', 'awaitingHuman', 'disconnected'].includes(activity.root.state)
      ? activity.root.state
      : (activity?.aggregateSubagents ?? 'idle'),
  );
  onMount(() => {
    const timer = window.setInterval(() => (now = Date.now()), 60_000);
    return () => window.clearInterval(timer);
  });

  function compactStatus(state: AgentActivityState, lastActivityAt: string): string {
    const elapsed = compactElapsedTime(lastActivityAt, now);
    return state === 'idle' || state === 'disconnected'
      ? `${labels[state]} since ${elapsed}`
      : `${labels[state]} · active ${elapsed} ago`;
  }
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

<section class="agent-activity" class:compact class:empty={!activity} aria-label="Agent activity">
  {#if activity}
    {#if compact}
      <details class="agents">
        <summary class="chip" data-state={compactState}
          >Agents ({activity.subagents.length + 1})</summary
        >
        <ul>
          <li>
            <span><strong>Root agent</strong> · supervisor</span>
            <time datetime={activity.root.lastActivityAt}
              >{compactStatus(activity.root.state, activity.root.lastActivityAt)}</time
            >
          </li>
          {#each activity.subagents as child (child.id)}
            <li>
              <span
                ><strong>{child.nickname ?? child.id}</strong>{child.role
                  ? ` · ${child.role}`
                  : ''}</span
              >
              <time datetime={child.lastActivityAt}
                >{compactStatus(child.state, child.lastActivityAt)}</time
              >
            </li>
          {/each}
        </ul>
      </details>
    {:else}
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
                <strong>{child.nickname ?? child.id}</strong>{child.role ? ` · ${child.role}` : ''} —
                {labels[child.state]} <small>{child.lastActivityAt}</small>
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
    {/if}
    <p class="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>
    {#if critical}<p class="visually-hidden" role="alert">{critical}</p>{/if}
  {/if}
</section>

<style>
  .agent-activity {
    max-inline-size: 100%;
    overflow-wrap: anywhere;
  }
  .compact.empty {
    display: none;
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
  .compact .agents {
    position: relative;
    inline-size: 100%;
  }
  .compact .agents > summary {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    inline-size: 100%;
    min-block-size: 44px;
    padding: 0.25rem 0.4rem;
    cursor: pointer;
    font-size: 0.8rem;
    text-align: center;
  }
  .compact .agents ul {
    position: absolute;
    z-index: 10;
    inset-block-end: calc(100% + 0.35rem);
    inset-inline-end: 0;
    box-sizing: border-box;
    display: grid;
    gap: 0.35rem;
    inline-size: min(22rem, calc(100vw - 1rem));
    max-block-size: min(20rem, 50vh);
    margin: 0;
    padding: 0.45rem;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 0.5rem;
    box-shadow: 0 0.35rem 1rem color-mix(in srgb, var(--theme-text) 18%, transparent);
  }
  .compact .agents li {
    display: grid;
    gap: 0.1rem;
    min-inline-size: 0;
    padding: 0.3rem;
    border-block-end: 1px solid var(--theme-border);
  }
  .compact .agents time {
    color: var(--theme-text-muted);
    font-size: 0.78rem;
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
