<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { orgPlanPosition } from '../../../shared/org-plan-position.js';
  import type { PlanStep, SupervisedPlan } from './contracts.js';
  import { presentPlan } from './plan-presentation.js';

  type Marker = Readonly<{
    id: string;
    position: string;
    state: PlanStep['state'];
    level: PlanStep['level'];
    title: string;
    effort?: string;
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
        level: step.level,
        title: step.title,
        ...(step.description.effort ? { effort: step.description.effort } : {}),
      },
      ...step.children.map((child, l2Index) => ({
        id: child.id,
        position: orgPlanPosition(l1Index + 1, l2Index + 1),
        state: child.state,
        level: child.level,
        title: child.title,
      })),
    ]),
  );
  let wipMarkers = $derived(markers.filter((marker) => marker.state === 'WIP'));
  let presentation = $derived(presentPlan(plan));
  let progressMax = $derived(Math.max(plan.totalSteps, 1));
</script>

<div class={['plan-progress', { compact }]}>
  <div class="progress-heading">
    <span>{plan.doneSteps} / {plan.totalSteps} work items done</span>
    <span>· {presentation.reviewedL1s} / {presentation.totalL1s} reviewed</span>
  </div>
  <progress aria-label={label} value={plan.doneSteps} max={progressMax}>
    {plan.doneSteps} of {plan.totalSteps} work items done
  </progress>
  <span class="review-status" data-phase={presentation.phase}>{presentation.label}</span>
  {#if compact && wipMarkers.length}
    <ol class="wip-steps" aria-label="Work in progress plan steps">
      {#each wipMarkers as marker (marker.id)}
        <li
          aria-current={marker.id === plan.currentStepId ? 'step' : undefined}
          aria-label={`${marker.position}: ${marker.title}, WIP${marker.level === 1 && marker.effort ? `, effort ${marker.effort}` : ''}`}
        >
          <span class="wip-position" aria-hidden="true">{marker.position} · WIP</span>
          <span class="wip-title">{marker.title}</span>
          {#if marker.level === 1 && marker.effort}
            <span class="wip-effort">Effort: {marker.effort}</span>
          {/if}
        </li>
      {/each}
    </ol>
  {:else if !compact && markers.length}
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

  .wip-steps {
    display: grid;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .wip-steps li {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: baseline;
    gap: 0.125rem 0.4rem;
    min-inline-size: 0;
    font-size: 0.625rem;
  }

  .wip-position {
    grid-row: 1 / span 2;
    align-self: start;
    padding: 0.125rem 0.25rem;
    border: 1px solid var(--theme-accent);
    border-radius: 999px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    white-space: nowrap;
  }

  .wip-title {
    min-inline-size: 0;
    overflow-wrap: anywhere;
    color: var(--theme-text);
    font-weight: 700;
  }

  .wip-effort {
    color: var(--theme-text-muted);
  }
</style>
