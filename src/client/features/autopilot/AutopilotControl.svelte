<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { AutopilotSnapshot } from './contracts.js';

  let {
    autopilot,
    controlId = 'autopilot-control',
    compact = false,
    pending = false,
    ontoggle = () => {},
  }: {
    autopilot: AutopilotSnapshot | null;
    controlId?: string;
    compact?: boolean;
    pending?: boolean;
    ontoggle?: (enabled: boolean) => void;
  } = $props();

  const names: Record<AutopilotSnapshot['state'], string> = {
    disabled: 'Off',
    monitoring: 'Monitoring',
    backoff: 'Waiting to continue',
    attentionRequired: 'Paused for attention',
    completed: 'Complete',
  };
  const reason: Record<string, string> = {
    planRequired: 'An incomplete supervised plan is required before Autopilot can start.',
    planComplete: 'This plan is complete, so Autopilot is unavailable.',
    sessionUnavailable: 'This session is unavailable for Autopilot.',
    attentionRequired: 'Autopilot is paused until the attention request is resolved.',
    noPlanProgress: 'Autopilot paused because the plan did not make durable progress.',
    reconcileFailed: 'Autopilot paused because it could not safely confirm session state.',
    planRemoved: 'The retained plan was removed.',
    planReplaced: 'The retained plan changed. Enable Autopilot again after reviewing it.',
    sessionEnded: 'This session ended.',
    manualDisabled: 'Autopilot is off.',
  };
  let status = $derived(autopilot ? names[autopilot.state] : 'Unavailable');
  let retryHelp = $derived(
    autopilot?.state === 'backoff' && autopilot.retry.position > 0 && autopilot.retry.limit > 0
      ? `Retry ${autopilot.retry.position} of ${autopilot.retry.limit}.`
      : null,
  );
  let help = $derived(
    (autopilot?.reason ? reason[autopilot.reason] : null) ??
      retryHelp ??
      (autopilot?.state === 'monitoring'
        ? 'Autopilot is monitoring this supervised plan.'
        : autopilot?.state === 'attentionRequired'
          ? 'Autopilot is paused for a pending attention request.'
          : 'Autopilot state is loading from the relay.'),
  );
  let liveStatus = $derived(`Autopilot status: ${status}. ${help}`);
  let enabled = $derived(autopilot?.enabled ?? false);
</script>

<section class="autopilot-control" class:compact aria-label="Autopilot">
  <p
    class="visually-hidden"
    data-testid="autopilot-live-status"
    aria-live="polite"
    aria-atomic="true"
  >
    {liveStatus}
  </p>
  {#if compact}
    <button
      class="compact-toggle"
      id={`${controlId}-button`}
      type="button"
      aria-pressed={enabled}
      aria-describedby={`${controlId}-help`}
      aria-disabled={pending}
      onclick={() => {
        if (!pending) ontoggle(!enabled);
      }}
    >
      <span aria-hidden="true">{enabled ? '●' : '○'}</span>
      Autopilot: {pending ? 'Updating…' : status}
    </button>
  {:else}
    <div class="control-row">
      <span class="status" data-state={autopilot?.state ?? 'unavailable'}>
        <span aria-hidden="true">{enabled ? '●' : '○'}</span> Autopilot: {status}
      </span>
      <button
        id={`${controlId}-button`}
        type="button"
        aria-pressed={enabled}
        aria-describedby={`${controlId}-help`}
        aria-disabled={pending}
        onclick={() => {
          if (!pending) ontoggle(!enabled);
        }}
      >
        {pending ? 'Updating…' : enabled ? 'Pause' : 'Enable'}
      </button>
    </div>
  {/if}
  <p id={`${controlId}-help`} class:visually-hidden={compact}>
    {help}
  </p>
</section>

<style>
  .autopilot-control {
    min-inline-size: 0;
    max-inline-size: 100%;
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }
  .control-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    align-items: center;
  }
  .compact {
    inline-size: 100%;
  }
  .compact-toggle {
    inline-size: 100%;
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
  }
  .status {
    border: 1px solid var(--theme-border);
    border-radius: 999px;
    padding: 0.35rem 0.55rem;
    overflow-wrap: anywhere;
  }
  .status[data-state='attentionRequired'],
  .status[data-state='unavailable'] {
    font-weight: 700;
    text-decoration: underline;
  }
  button {
    min-block-size: 44px;
    min-inline-size: 44px;
    padding: 0.45rem 0.75rem;
    font: inherit;
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }
  button:focus-visible {
    outline: 3px solid var(--theme-accent);
    outline-offset: 2px;
  }
  button[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.65;
  }
  p {
    margin: 0.25rem 0 0;
    color: var(--theme-text-muted);
    overflow-wrap: anywhere;
  }
  .visually-hidden {
    position: absolute;
    clip-path: inset(50%);
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    border: 0;
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
