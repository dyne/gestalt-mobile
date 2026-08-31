<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script lang="ts">
  import { formatLivenessElapsed } from './liveness.js';
  import type { AutopilotSnapshot } from './contracts.js';
  let {
    autopilot,
    connected = true,
  }: { autopilot: AutopilotSnapshot | null; connected?: boolean } = $props();
  let livenessState = $derived(!connected ? 'disconnected' : (autopilot?.state ?? 'unknown'));
  let active = $derived(livenessState === 'monitoring' || livenessState === 'backoff');
  let now = $state(Date.now());
  let visible = $state(typeof document === 'undefined' || document.visibilityState !== 'hidden');
  let label = $derived(
    livenessState === 'disconnected'
      ? 'Monitoring disconnected'
      : livenessState === 'attentionRequired'
        ? 'Monitoring needs attention'
        : livenessState === 'safetyPaused'
          ? 'Monitoring safety paused'
          : active
            ? 'Monitoring active'
            : 'Monitoring inactive',
  );

  function refreshClock() {
    visible = document.visibilityState !== 'hidden';
    if (visible) now = Date.now();
  }

  $effect(() => {
    if (!active || !visible) return;
    const interval = window.setInterval(() => (now = Date.now()), 1_000);
    return () => window.clearInterval(interval);
  });
</script>

<svelte:document onvisibilitychange={refreshClock} />

<span class:active class="liveness" data-state={livenessState} aria-label={label} role="status">
  <span aria-hidden="true" class="dot"></span>
  <span>{label}</span>
  {#if autopilot && active}
    <time datetime={autopilot.updatedAt}>{formatLivenessElapsed(autopilot.updatedAt, now)}</time>
  {/if}
</span>

<style>
  .liveness {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
    color: var(--theme-text-muted);
    font-size: 0.875rem;
  }
  .dot {
    inline-size: 0.55rem;
    block-size: 0.55rem;
    border-radius: 50%;
    background: currentColor;
  }
  .active .dot {
    animation: pulse 1.6s ease-out infinite;
    color: var(--theme-accent);
  }
  time {
    color: var(--theme-text-muted);
  }
  [data-state='attentionRequired'],
  [data-state='safetyPaused'],
  [data-state='disconnected'] {
    font-weight: 700;
    text-decoration: underline;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
      transform: scale(0.75);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .active .dot {
      animation: none;
    }
  }
</style>
