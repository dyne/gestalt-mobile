<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import AgentActivityIndicators from './AgentActivityIndicators.svelte';
  const activity = {
    sessionId: 'evidence',
    confidence: 'reconciling' as const,
    aggregateSubagents: 'working' as const,
    root: {
      state: 'awaitingAgent' as const,
      observedAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    },
    subagents: [
      {
        id: 'α-worker',
        nickname: 'α worker',
        role: 'research',
        state: 'working' as const,
        observedAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const states = [
    'working',
    'awaitingAgent',
    'awaitingHuman',
    'blocked',
    'idle',
    'disconnected',
  ] as const;
</script>

<main>
  <h1>Activity evidence</h1>
  <AgentActivityIndicators {activity} />{#each states as state (state)}<AgentActivityIndicators
      activity={{
        ...activity,
        sessionId: state,
        confidence: state === 'blocked' ? 'stale' : 'fresh',
        root: { ...activity.root, state },
        aggregateSubagents: state,
      }}
    />{/each}
</main>

<style>
  main {
    box-sizing: border-box;
    max-inline-size: 100vw;
    padding: 1rem;
  }
  h1 {
    overflow-wrap: anywhere;
  }
</style>
