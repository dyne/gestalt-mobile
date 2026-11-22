<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { RelaySession } from './relay-client.js';
  import { isSessionStatus } from './session-status.js';

  let { status }: { status?: RelaySession['sessionStatus'] } = $props();
  let verdict = $derived(isSessionStatus(status) ? status : null);
</script>

{#if verdict}
  {@const label = verdict.state === 'working' ? 'Working' : 'Idle'}
  <details
    class="session-verdict"
    data-state={verdict.state}
    aria-label={`${label}: ${verdict.reason}`}
  >
    <summary aria-label={`${label}: ${verdict.reason}`}>
      <span
        class:live={verdict.state === 'working' && verdict.confidence === 'fresh'}
        class="verdict-dot"
        aria-hidden="true"
      ></span>
      {label}
    </summary>
    <p>
      {verdict.reason}. {verdict.nextExpectedAction}
      Evidence confidence: {verdict.confidence}.
    </p>
  </details>
{/if}

<style>
  .session-verdict {
    margin-block-end: 0.45rem;
    color: var(--theme-text-muted);
  }
  summary {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
    cursor: pointer;
    color: var(--theme-text);
    font-weight: 700;
  }
  p {
    max-inline-size: 65ch;
    margin: 0.35rem 0 0;
  }
  .verdict-dot {
    inline-size: 0.55rem;
    block-size: 0.55rem;
    border-radius: 50%;
    background: currentColor;
  }
  .verdict-dot.live {
    color: var(--theme-accent);
    animation: status-pulse 1.6s ease-out infinite;
  }
  @keyframes status-pulse {
    50% {
      opacity: 0.35;
      transform: scale(0.75);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .verdict-dot.live {
      animation: none;
    }
  }
</style>
