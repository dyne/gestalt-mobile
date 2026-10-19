<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { AutopilotSnapshot, OrgPlanAttention } from './contracts.js';
  import { describeProviderFailure } from '../../../shared/contracts/provider-failure.js';
  import {
    isReconciliationRecovery,
    reconciliationRecoveryMessage,
  } from '../../../shared/contracts/autopilot-recovery.js';

  let {
    autopilot,
    attention,
    controlId = 'autopilot-safety-stop',
    pending = false,
    onrecover = () => {},
    ondisable = () => {},
  }: {
    autopilot: AutopilotSnapshot | null;
    attention: OrgPlanAttention | null;
    controlId?: string;
    pending?: boolean;
    onrecover?: () => void;
    ondisable?: () => void;
  } = $props();

  const reasons: Record<string, string> = {
    attentionRequired:
      'The coordinator stopped because it needs a human safety decision, but no actionable agent request is available.',
    noPlanProgress:
      'The coordinator stopped because recent automatic turns made no durable plan progress.',
    reconcileFailed:
      'The coordinator stopped because it could not safely confirm the session state.',
    startUnavailable:
      'The coordinator stopped because the session runtime was unavailable when it tried to start an automatic turn.',
    actionRateExceeded:
      'The coordinator stopped because it reached the automatic-action safety limit.',
  };
  let providerFailure = $derived(autopilot?.providerFailure);
  let manualFailure = $derived(
    Boolean(providerFailure && ['disabled', 'completed'].includes(autopilot?.state ?? '')),
  );
  let retryPending = $derived(autopilot?.providerRetry?.pending ?? false);
  let message = $derived(
    providerFailure
      ? describeProviderFailure(providerFailure)
      : autopilot?.reason && !attention
        ? (reasons[autopilot.reason] ?? null)
        : null,
  );
  let recovering = $derived(isReconciliationRecovery(autopilot));
  let recovery = $derived(
    manualFailure
      ? 'Automatic supervision was not running. Retry your message when the provider is available.'
      : retryPending
        ? `A delayed retry is scheduled (attempt ${autopilot?.providerRetry?.attempt} of 2). It will proceed only after the failed turn has ended and the session is idle.`
        : providerFailure
          ? 'Address this failure, then retry Autopilot when ready.'
          : autopilot?.reason === 'startUnavailable'
            ? 'There is no pending agent attention request to answer. Restore or reopen this session, then retry Autopilot.'
            : autopilot?.reason === 'actionRateExceeded'
              ? 'There is no pending agent attention request to answer. Wait for the ten-minute safety window to clear, or continue manually.'
              : 'There is no pending agent attention request to answer. Retry the supported Autopilot coordinator after addressing the cause, or disable it.',
  );
</script>

{#if !attention && (providerFailure || recovering || (autopilot?.state === 'attentionRequired' && message))}
  <section
    class="safety-stop"
    class:recovering={recovering || Boolean(providerFailure)}
    role="alert"
    aria-labelledby={`${controlId}-title`}
  >
    <h3 id={`${controlId}-title`}>
      {providerFailure
        ? manualFailure
          ? 'Codex request failed'
          : 'Codex execution paused'
        : recovering
          ? 'Autopilot recovery warning'
          : 'Autopilot safety stop'}
    </h3>
    {#if recovering}
      <p>{reconciliationRecoveryMessage}</p>
    {:else}
      <p>{message}</p>
      <p>{recovery}</p>
    {/if}
    <div class="actions">
      {#if !manualFailure}
        <button type="button" disabled={pending || retryPending} onclick={onrecover}
          >{pending ? 'Updating…' : 'Retry Autopilot'}</button
        >
      {/if}
      <button type="button" disabled={pending} onclick={ondisable}
        >{manualFailure ? 'Dismiss' : 'Disable Autopilot'}</button
      >
    </div>
  </section>
{/if}

<style>
  .safety-stop {
    border: 2px solid var(--theme-error);
    border-inline-start-width: 0.5rem;
    border-radius: 0.5rem;
    padding: 0.75rem;
    overflow-wrap: anywhere;
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }
  h3,
  p {
    margin: 0 0 0.5rem;
  }
  .recovering {
    border-color: var(--theme-warning);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  button {
    min-block-size: 44px;
    padding: 0.45rem 0.75rem;
    font: inherit;
  }
  button:focus-visible {
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
