<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import AppControl from '../../components/AppControl.svelte';
  import { orgPlanAgentDisplayName } from '../../../shared/org-plan-position.js';
  import type { AgentActivitySnapshot, AgentActivityState } from './contracts.js';
  import { activityAnnouncement } from './announcement-policy.js';
  import { compactElapsedTime } from './relative-activity-time.js';
  let {
    activity,
    compact = false,
    rootModel,
  }: { activity: AgentActivitySnapshot | null; compact?: boolean; rootModel?: string } = $props();
  const labels: Record<AgentActivityState, string> = {
    working: 'working',
    idle: 'idle',
    awaitingAgent: 'waiting for child',
    awaitingHuman: 'needs you',
    blocked: 'blocked',
    disconnected: 'disconnected',
  };
  type MonitorAgent = Readonly<{
    key: string;
    name: string;
    role?: string;
    model?: string;
    state: AgentActivityState;
    lastActivityAt: string;
  }>;
  const stateOrder: Record<AgentActivityState, number> = {
    working: 0,
    awaitingAgent: 1,
    awaitingHuman: 1,
    blocked: 1,
    idle: 2,
    disconnected: 3,
  };
  let announcement = $state('');
  let critical = $state('');
  let previousActivity: AgentActivitySnapshot | null = null;
  let now = $state(Date.now());
  let category = $derived(
    activity ? `${activity.sessionId}:${activity.root.state}:${activity.aggregateSubagents}` : '',
  );
  let compactState = $derived(
    !activity
      ? 'unavailable'
      : ['blocked', 'awaitingHuman', 'disconnected'].includes(activity.root.state)
        ? activity.root.state
        : activity.aggregateSubagents,
  );
  let orderedAgents = $derived.by<readonly MonitorAgent[]>(() => {
    if (!activity) return [];
    return [
      {
        key: 'root',
        name: 'Root agent',
        role: 'supervisor',
        ...(rootModel ? { model: rootModel } : {}),
        state: activity.root.state,
        lastActivityAt: activity.root.lastActivityAt,
      },
      ...activity.subagents.map((child) => ({
        key: `child:${child.id}`,
        name: orgPlanAgentDisplayName(child.nickname ?? child.id),
        ...(child.role ? { role: child.role } : {}),
        ...(child.model ? { model: child.model } : {}),
        state: child.state,
        lastActivityAt: child.lastActivityAt,
      })),
    ].sort(
      (left, right) =>
        stateOrder[left.state] - stateOrder[right.state] || left.name.localeCompare(right.name),
    );
  });
  let orderedSubagents = $derived(
    activity
      ? [...activity.subagents].sort(
          (left, right) =>
            stateOrder[left.state] - stateOrder[right.state] ||
            orgPlanAgentDisplayName(left.nickname ?? left.id).localeCompare(
              orgPlanAgentDisplayName(right.nickname ?? right.id),
            ),
        )
      : [],
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

<section class="agent-activity" class:compact aria-label="Agent activity">
  {#if compact}
    <details class="agents">
      <AppControl element="summary" compact full state={compactState}
        >Agents ({(activity?.subagents.length ?? 0) + 1})</AppControl
      >
      <ul>
        {#if activity}
          {#each orderedAgents as agent (agent.key)}
            <li>
              <strong>{agent.name}</strong>
              <span class="agent-metadata"
                >{[agent.role, agent.model ? `Model: ${agent.model}` : 'Model unavailable']
                  .filter(Boolean)
                  .join(' · ')}</span
              >
              <time datetime={agent.lastActivityAt}
                >{compactStatus(agent.state, agent.lastActivityAt)}</time
              >
            </li>
          {/each}
        {:else}
          <li>
            <strong>Root agent</strong>
            <span class="agent-metadata"
              >{['supervisor', rootModel ? `Model: ${rootModel}` : 'Model unavailable'].join(
                ' · ',
              )}</span
            >
            <span class="unavailable" role="status">activity unavailable</span>
          </li>
        {/if}
      </ul>
    </details>
  {:else if activity}
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
          {#each orderedSubagents as child (child.id)}
            <li>
              <strong>{orgPlanAgentDisplayName(child.nickname ?? child.id)}</strong>{child.role
                ? ` · ${child.role}`
                : ''}{child.model ? ` · Model: ${child.model}` : ''} —
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
  {#if activity}
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
  .compact .agents {
    position: relative;
    inline-size: 100%;
  }
  .compact .agents ul {
    position: absolute;
    z-index: 10;
    inset-block-end: calc(100% + 0.35rem);
    inset-inline-end: 0;
    box-sizing: border-box;
    display: grid;
    gap: 0.35rem;
    inline-size: min(22rem, calc(100vw - max(2.5rem, 48px)));
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
  .compact .agents .agent-metadata {
    color: var(--theme-text-muted);
    font-size: 0.78rem;
  }
  .compact .agents .unavailable {
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
  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
