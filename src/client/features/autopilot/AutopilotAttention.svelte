<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { OrgPlanAttention } from './contracts.js';
  let {
    attention,
    controlId = 'autopilot-attention',
    pending = false,
    onresolve = () => {},
  }: {
    attention: OrgPlanAttention | null;
    pending?: boolean;
    controlId?: string;
    onresolve?: (action: 'resume' | 'disableAutopilot', guidance?: string) => void;
  } = $props();
  let guidance = $state('');
  const reasons: Record<string, string> = {
    planChange: 'Plan change needs approval',
    hardBlock: 'Work is blocked',
    missingDependency: 'A required capability is missing',
    permissionRequired: 'Permission is needed',
    externalState: 'An external condition changed',
    materialAmbiguity: 'A decision is needed',
  };
  const resumeConditions: Record<string, string> = {
    userGuidance: 'You have provided the decision or guidance below.',
    planRevision: 'You have approved or revised the plan.',
    dependencyInstalled: 'The required capability is available.',
    permissionGranted: 'The required permission has been granted.',
    externalStateChanged:
      'The blocker has been resolved, or you have provided a way forward below.',
  };
  let compact = $derived(
    attention?.attention.summary.startsWith('Supervised execution requires human attention ('),
  );
  let guidanceError = $derived(
    guidance.trim().length > 600 ? 'Guidance must be 600 characters or fewer.' : '',
  );
</script>

{#if attention}
  <section class="attention" role="alert" aria-labelledby={`${controlId}-title`}>
    <h3 id={`${controlId}-title`}>Autopilot needs your attention</h3>
    <dl>
      <div>
        <dt>Reason</dt>
        <dd>{reasons[attention.attention.reason] ?? 'Supervised work needs attention'}</dd>
      </div>
      <div>
        <dt>What happened</dt>
        <dd>
          {compact
            ? 'The supervisor has paused work and needs your help to continue.'
            : attention.attention.summary}
        </dd>
      </div>
      {#if attention.supervisorReport}
        <div>
          <dt>Supervisor explanation</dt>
          <dd class="supervisor-report">{attention.supervisorReport}</dd>
        </div>
      {:else if compact}
        <div>
          <dt>Supervisor explanation</dt>
          <dd>
            The supervisor has not supplied an explanation yet. You can ask for details in the
            guidance below.
          </dd>
        </div>
      {/if}
      <div>
        <dt>Requested action</dt>
        <dd>
          {compact
            ? 'Resolve the blocker or describe a way forward below, then choose Resume. You can also disable Autopilot.'
            : attention.attention.requestedAction}
        </dd>
      </div>
      <div>
        <dt>Resume when</dt>
        <dd>
          {resumeConditions[attention.attention.resumeCondition] ??
            'You are ready for the supervisor to continue.'}
        </dd>
      </div>
    </dl>
    <label for={`${controlId}-guidance`}>Optional guidance for the resumed work</label>
    <textarea
      id={`${controlId}-guidance`}
      bind:value={guidance}
      maxlength="600"
      aria-describedby={`${controlId}-guidance-help`}
      aria-invalid={Boolean(guidanceError)}></textarea>
    <p id={`${controlId}-guidance-help`} class="guidance-help">
      {guidanceError || 'Up to 600 characters. Do not include secrets.'}
    </p>
    <div class="actions">
      <button
        type="button"
        disabled={pending || Boolean(guidanceError)}
        onclick={() => (guidance.trim() ? onresolve('resume', guidance) : onresolve('resume'))}
        >{pending
          ? 'Updating…'
          : attention.attention.executorReplacement
            ? 'Authorize replacement'
            : 'Resume'}</button
      >
      <button type="button" disabled={pending} onclick={() => onresolve('disableAutopilot')}
        >Disable Autopilot</button
      >
    </div>
  </section>
{/if}

<style>
  .attention {
    border: 2px solid var(--theme-error);
    border-inline-start-width: 0.5rem;
    border-radius: 0.5rem;
    padding: 0.75rem;
    overflow-wrap: anywhere;
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }
  h3 {
    margin: 0;
  }
  dl {
    display: grid;
    gap: 0.35rem;
  }
  dl div {
    display: grid;
    gap: 0.15rem;
  }
  dt {
    font-weight: 700;
  }
  dd {
    margin: 0;
  }
  .supervisor-report {
    white-space: pre-wrap;
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
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }
  textarea {
    inline-size: 100%;
    box-sizing: border-box;
    min-block-size: 5rem;
    font: inherit;
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }
  .guidance-help {
    margin: 0.25rem 0;
    color: var(--theme-text-muted);
  }
  button:focus-visible {
    outline: 3px solid var(--theme-accent);
    outline-offset: 2px;
  }
</style>
