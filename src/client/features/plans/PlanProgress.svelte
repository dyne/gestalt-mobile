<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { orgPlanPosition } from '../../../shared/org-plan-position.js';
  import type { PlanStep, SupervisedPlan } from './contracts.js';

  type Marker = Readonly<{
    id: string;
    position: string;
    state: PlanStep['state'];
  }>;

  let {
    plan,
    compact = false,
    label = 'Plan progress',
  }: {
    plan: SupervisedPlan;
    compact?: boolean;
    label?: string;
  } = $props();

  let markers = $derived.by<readonly Marker[]>(() =>
    plan.steps.flatMap((step, l1Index) => [
      {
        id: step.id,
        position: orgPlanPosition(l1Index + 1),
        state: step.state,
      },
      ...step.children.map((child, l2Index) => ({
        id: child.id,
        position: orgPlanPosition(l1Index + 1, l2Index + 1),
        state: child.state,
      })),
    ]),
  );
  let progressMax = $derived(Math.max(plan.totalSteps, 1));
</script>

<div class={['plan-progress', { compact }]}>
  <div class="progress-heading">
    <span>{plan.doneSteps} / {plan.totalSteps} complete</span>
  </div>
  <progress aria-label={label} value={plan.doneSteps} max={progressMax}>
    {plan.doneSteps} of {plan.totalSteps} complete
  </progress>
  {#if markers.length}
    <ol class="step-markers" aria-label="Plan step progress">
      {#each markers as marker (marker.id)}
        <li
          data-state={marker.state}
          aria-current={marker.id === plan.currentStepId ? 'step' : undefined}
          aria-label={`${marker.position}: ${marker.state}`}
        >
          <span aria-hidden="true" class="position">{marker.position}</span>
          <span aria-hidden="true" class="state">{marker.state}</span>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .plan-progress {
    display: grid;
    gap: 0.5rem;
    min-inline-size: 0;
  }
  .progress-heading {
    display: flex;
    justify-content: flex-end;
    color: var(--theme-text-muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }
  progress {
    inline-size: 100%;
    block-size: 0.5rem;
    accent-color: var(--theme-accent);
  }
  .step-markers {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step-markers li {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
    min-inline-size: 0;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
    color: var(--theme-text-muted);
    background: var(--theme-surface);
    font-size: 0.75rem;
    line-height: 1.2;
  }
  .step-markers li[data-state='DONE'] {
    color: var(--theme-control-pressed-contrast);
    background: var(--theme-control-pressed);
    border-color: var(--theme-control-pressed);
  }
  .step-markers li[data-state='WIP'] {
    color: var(--theme-text);
    border-color: var(--theme-accent);
    font-weight: 700;
  }
  .step-markers li[aria-current='step'] {
    outline: 2px solid var(--theme-accent);
    outline-offset: 1px;
  }
  .position {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .compact {
    gap: 0.25rem;
  }
  .compact .progress-heading {
    font-size: 0.6875rem;
  }
  .compact progress {
    block-size: 0.375rem;
  }
  .compact .step-markers li {
    gap: 0.125rem;
    padding: 0.125rem 0.25rem;
    font-size: 0.625rem;
  }
</style>
