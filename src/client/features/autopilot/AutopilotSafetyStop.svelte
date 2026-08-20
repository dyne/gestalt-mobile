<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { AutopilotSnapshot, OrgPlanAttention } from './contracts.js';

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
    startUnavailable: 'The coordinator stopped because it could not start an automatic turn.',
  };
  let message = $derived(
    autopilot?.reason && !attention ? (reasons[autopilot.reason] ?? null) : null,
  );
</script>

{#if autopilot?.state === 'attentionRequired' && message}
  <section class="safety-stop" role="alert" aria-labelledby={`${controlId}-title`}>
    <h3 id={`${controlId}-title`}>Autopilot safety stop</h3>
    <p>{message}</p>
    <p>
      There is no pending agent attention request to answer. Retry the supported Autopilot
      coordinator after addressing the cause, or disable it.
    </p>
    <div class="actions">
      <button type="button" disabled={pending} onclick={onrecover}
        >{pending ? 'Updating…' : 'Retry Autopilot'}</button
      >
      <button type="button" disabled={pending} onclick={ondisable}>Disable Autopilot</button>
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
