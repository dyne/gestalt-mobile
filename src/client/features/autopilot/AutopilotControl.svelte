<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import AppControl from '../../components/AppControl.svelte';
  import { checkpointHandoffRecoveryMessage } from '../../../shared/contracts/autopilot-recovery.js';
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
    safetyPaused: 'Safety paused',
  };
  const phaseNames: Record<NonNullable<AutopilotSnapshot['health']>['phase'], string> = {
    off: 'Off',
    rootWorking: 'On · root working',
    continuationScheduled: 'On · continuation scheduled',
    waitingForAgentEvent: 'On · waiting for agent event',
    checkingState: 'On · checking state',
    needsYou: 'Paused · needs you',
    safetyPaused: 'Safety paused',
    complete: 'Complete',
    checkpointRecovery: 'Recovering checkpoint handoff',
    degraded: 'On · continuation unavailable',
  };
  const reason: Record<string, string> = {
    planRequired: 'An incomplete supervised plan is required before Autopilot can start.',
    planComplete: 'This plan is complete, so Autopilot is unavailable.',
    sessionUnavailable: 'This session is unavailable for Autopilot.',
    attentionRequired: 'Autopilot is paused because an agent is waiting for human input.',
    noPlanProgress: 'Autopilot paused because the plan did not make durable progress.',
    reconcileFailed: 'Autopilot paused because it could not safely confirm session state.',
    startUnavailable:
      'Automatic continuation could not start because the session runtime is unavailable. Restore or reopen the session, then retry Autopilot.',
    actionRateExceeded:
      'Autopilot paused after too many automatic actions in ten minutes. Wait for the safety window to clear, or continue manually.',
    planRemoved: 'The retained plan was removed.',
    planReplaced: 'The retained plan changed. Enable Autopilot again after reviewing it.',
    sessionEnded: 'This session ended.',
    manualDisabled: 'Autopilot is off.',
    safetyPaused:
      'Autopilot paused after a repeated or invalid automatic continuation. Resume manually when ready.',
    checkpointHandoffFailed: checkpointHandoffRecoveryMessage,
  };
  let status = $derived(
    autopilot
      ? autopilot.health
        ? phaseNames[autopilot.health.phase]
        : names[autopilot.state]
      : 'Unavailable',
  );
  let retryHelp = $derived(
    autopilot?.state === 'backoff' && autopilot.retry.position > 0 && autopilot.retry.limit > 0
      ? `Retry ${autopilot.retry.position} of ${autopilot.retry.limit}.`
      : null,
  );
  let help = $derived(
    (autopilot?.reason ? reason[autopilot.reason] : null) ??
      retryHelp ??
      autopilot?.health?.nextExpectedAction ??
      (autopilot?.state === 'monitoring'
        ? 'Autopilot is monitoring this supervised plan.'
        : autopilot?.state === 'attentionRequired'
          ? 'Autopilot is paused because human attention is required.'
          : 'Autopilot state is loading from the relay.'),
  );
  let liveStatus = $derived(`Autopilot status: ${status}. ${help}`);
  let enabled = $derived(autopilot?.enabled ?? false);
  let hasError = $derived(
    autopilot?.state === 'safetyPaused' || autopilot?.health?.phase === 'degraded',
  );
</script>

<section
  class="autopilot-control"
  class:compact
  class:has-error={compact && hasError}
  aria-label="Autopilot"
>
  <p
    class="visually-hidden"
    data-testid="autopilot-live-status"
    aria-live="polite"
    aria-atomic="true"
  >
    {liveStatus}
  </p>
  {#if compact}
    <AppControl
      id={`${controlId}-button`}
      compact
      icon={pending || autopilot?.state === 'backoff' ? 'waiting' : 'autopilot'}
      pressed={enabled}
      accentPressed
      label={`Autopilot: ${pending ? 'Updating' : status}`}
      describedby={`${controlId}-help`}
      ariaDisabled={pending}
      onclick={() => {
        if (!pending) ontoggle(!enabled);
      }}
    >
      {#if hasError || autopilot?.state === 'attentionRequired'}<span
          class="state-mark"
          aria-hidden="true">!</span
        >{:else if enabled}<span class="enabled-mark" aria-hidden="true"></span>{/if}
    </AppControl>
  {:else}
    <div class="control-row">
      <span class="status" data-state={autopilot?.state ?? 'unavailable'}>
        <span aria-hidden="true">{enabled ? '●' : '○'}</span> Autopilot: {status}
      </span>
      <AppControl
        id={`${controlId}-button`}
        pressed={enabled}
        describedby={`${controlId}-help`}
        ariaDisabled={pending}
        onclick={() => {
          if (!pending) ontoggle(!enabled);
        }}
      >
        {pending ? 'Updating…' : enabled ? 'Pause' : 'Enable'}
      </AppControl>
    </div>
  {/if}
  <p id={`${controlId}-help`} class:visually-hidden={compact}>
    {help}
  </p>
</section>

<style>
  .has-error :global(button[aria-pressed]) {
    color: var(--theme-error);
    border-color: var(--theme-error);
    border-style: dashed;
    background: var(--theme-surface);
  }
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
    position: relative;
    inline-size: auto;
  }
  .enabled-mark {
    position: absolute;
    inset-inline-end: 4px;
    inset-block-end: 7px;
    width: 7px;
    height: 4px;
    border: solid currentColor;
    border-width: 0 0 2px 2px;
    transform: rotate(-45deg);
  }
  .state-mark {
    position: absolute;
    inset: 2px 2px auto auto;
    font-weight: 750;
    font-size: 0.75rem;
    line-height: 1;
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
