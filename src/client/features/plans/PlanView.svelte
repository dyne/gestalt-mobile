<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { tick } from 'svelte';

  import { orgPlanPosition } from '../../../shared/org-plan-position.js';
  import type { PlanStep, SupervisedPlan } from './contracts.js';
  import type { PlanState } from './plan-controller.js';
  import PlanProgress from './PlanProgress.svelte';

  type Props = { state: PlanState; onclose: () => void };
  type DescriptionKey = keyof PlanStep['description'];

  const descriptionLabels: Readonly<Record<DescriptionKey, string>> = {
    effort: 'Effort',
    goal: 'Goal',
    notes: 'Notes',
    why: 'Why',
    change: 'Change',
    tests: 'Tests',
    doneWhen: 'Done when',
  };

  let { state: viewState, onclose }: Props = $props();
  let opened = $state<Set<string>>(new Set());
  let detailsById = $state<Partial<Record<string, HTMLDetailsElement>>>({});
  let lastCurrentStepId: string | null = null;
  let scrollGeneration = 0;
  let plan = $derived(
    viewState.kind === 'ready' || viewState.kind === 'closing'
      ? viewState.plan
      : viewState.kind === 'error'
        ? viewState.plan
        : undefined,
  );
  let currentStep = $derived(plan ? findStep(plan.steps, plan.currentStepId) : undefined);
  let currentPosition = $derived(plan ? findPosition(plan.steps, plan.currentStepId) : undefined);
  let automaticOpenIds = $derived(
    plan ? currentPath(plan.steps, plan.currentStepId) : new Set<string>(),
  );
  let announcement = $derived.by(() => {
    if (viewState.kind === 'loading') return 'Loading plan.';
    if (viewState.kind === 'unavailable') return 'No retained plan for this session.';
    if (viewState.kind === 'error' && !plan) return viewState.error;
    if (viewState.kind === 'closing') return 'Closing completed plan.';
    if (!plan) return '';
    if (!currentStep)
      return `${plan.doneSteps} of ${plan.totalSteps} plan steps complete.${viewState.kind === 'error' ? ` ${viewState.error}` : ''}`;
    return `Current step: ${currentPosition} ${currentStep.title}, ${currentStep.state}. ${plan.doneSteps} of ${plan.totalSteps} complete.${viewState.kind === 'error' ? ` ${viewState.error}` : ''}`;
  });

  $effect(() => {
    const currentStepId = plan?.currentStepId || null;
    if (!currentStepId) return;
    if (lastCurrentStepId === currentStepId) return;
    lastCurrentStepId = currentStepId;
    const generation = ++scrollGeneration;
    void tick().then(() => {
      if (generation !== scrollGeneration || plan?.currentStepId !== currentStepId) return;
      detailsById[currentStepId]?.scrollIntoView({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest',
      });
    });
  });

  function findStep(steps: readonly PlanStep[], id: string): PlanStep | undefined {
    for (const step of steps) {
      if (step.id === id) return step;
      const child = findStep(step.children, id);
      if (child) return child;
    }
    return undefined;
  }

  function findPosition(steps: readonly PlanStep[], id: string): string | undefined {
    for (const [l1Index, step] of steps.entries()) {
      if (step.id === id) return orgPlanPosition(l1Index + 1);
      const l2Index = step.children.findIndex((child) => child.id === id);
      if (l2Index >= 0) return orgPlanPosition(l1Index + 1, l2Index + 1);
    }
    return undefined;
  }

  function currentPath(
    steps: readonly PlanStep[],
    id: string,
    ancestors: readonly string[] = [],
  ): Set<string> {
    for (const step of steps) {
      if (step.id === id) return new Set([...ancestors, step.id]);
      const path = currentPath(step.children, id, [...ancestors, step.id]);
      if (path.size) return path;
    }
    return new Set();
  }

  function isOpen(id: string): boolean {
    return opened.has(id) || automaticOpenIds.has(id);
  }

  function toggle(id: string, open: boolean): void {
    opened = open ? new Set([...opened, id]) : new Set([...opened].filter((value) => value !== id));
  }

  function summary(step: PlanStep): string {
    return step.description.goal ?? step.description.why ?? step.title;
  }

  function measurementSummary(step: PlanStep): string {
    const measurement = step.measurement;
    if (!measurement) return 'Measurements unavailable';
    const values: string[] = [];
    if (measurement.elapsedSeconds !== undefined)
      values.push(
        `${Math.floor(measurement.elapsedSeconds / 60)}m ${measurement.elapsedSeconds % 60}s elapsed`,
      );
    if (measurement.weeklyPercentUsed !== undefined)
      values.push(`${measurement.weeklyPercentUsed}% observed account-wide usage`);
    if (measurement.tokensUsed !== undefined)
      values.push(`${measurement.tokensUsed.toLocaleString()} tokens used`);
    return values.join(' · ') || 'Measurements unavailable';
  }

  function descriptionEntries(step: PlanStep): Array<readonly [string, string]> {
    return (Object.keys(descriptionLabels) as DescriptionKey[]).flatMap((key) => {
      const value = step.description[key];
      return value ? [[descriptionLabels[key], value] as const] : [];
    });
  }
</script>

<p class="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>

{#if viewState.kind === 'loading'}
  <section aria-labelledby="plan-title">
    <h2 id="plan-title">Plan</h2>
    <p>Loading plan…</p>
  </section>
{:else if viewState.kind === 'unavailable'}
  <section aria-labelledby="plan-title">
    <h2 id="plan-title">Plan</h2>
    <p>No retained plan for this session.</p>
  </section>
{:else if viewState.kind === 'error' && !plan}
  <section aria-labelledby="plan-title">
    <h2 id="plan-title">Plan</h2>
    <p>{viewState.error}</p>
  </section>
{:else if plan}
  <section class="plan" aria-labelledby="plan-title">
    <header>
      <div>
        <h2 id="plan-title">{plan.title}</h2>
      </div>
      <button class="close" aria-label="Close plan and return to list" onclick={onclose}>×</button>
    </header>
    <PlanProgress {plan} />
    <p>
      Current: {currentStep
        ? `${currentPosition} ${currentStep.title} (${currentStep.state})`
        : 'No current step'}
    </p>
    {#if viewState.kind === 'error'}
      <p>{viewState.error}</p>
    {/if}
    {#if plan.subtitle || plan.date || plan.keywords}
      <dl class="metadata">
        {#if plan.subtitle}<div>
            <dt>Subtitle</dt>
            <dd>{plan.subtitle}</dd>
          </div>{/if}
        {#if plan.date}<div>
            <dt>Date</dt>
            <dd>{plan.date}</dd>
          </div>{/if}
        {#if plan.keywords}<div>
            <dt>Keywords</dt>
            <dd>{plan.keywords}</dd>
          </div>{/if}
      </dl>
    {/if}
    {#if plan.steps.length === 0}
      <p>No plan steps have been retained yet.</p>
    {:else}
      <ol class="plan-steps">
        {#each plan.steps as step, l1Index (step.id)}
          <li>
            <details
              bind:this={detailsById[step.id]}
              data-step-id={step.id}
              open={isOpen(step.id)}
              ontoggle={(event) => toggle(step.id, event.currentTarget.open)}
            >
              <summary>
                <strong
                  ><span class="position">{orgPlanPosition(l1Index + 1)}</span> {step.title}</strong
                >
                <span
                  >{step.state} · Priority {step.priority}{step.reviewStatus
                    ? ` · ${step.reviewStatus}`
                    : ''}</span
                >
                <span>{summary(step)}</span>
                <span class="measurement">{measurementSummary(step)}</span>
              </summary>
              {#each descriptionEntries(step) as [label, value] (label)}
                <p><strong>{label}:</strong> {value}</p>
              {/each}
              {#if step.skills?.length}<p><strong>Skills:</strong> {step.skills.join(', ')}</p>{/if}
              {#if step.children.length}
                <ol>
                  {#each step.children as child, l2Index (child.id)}
                    <li>
                      <details
                        bind:this={detailsById[child.id]}
                        data-step-id={child.id}
                        open={isOpen(child.id)}
                        ontoggle={(event) => toggle(child.id, event.currentTarget.open)}
                      >
                        <summary>
                          <strong
                            ><span class="position"
                              >{orgPlanPosition(l1Index + 1, l2Index + 1)}</span
                            >
                            {child.title}</strong
                          >
                          <span
                            >{child.state} · Priority {child.priority}{child.reviewStatus
                              ? ` · ${child.reviewStatus}`
                              : ''}</span
                          >
                          <span>{summary(child)}</span>
                        </summary>
                        {#each descriptionEntries(child) as [label, value] (label)}
                          <p><strong>{label}:</strong> {value}</p>
                        {/each}
                        {#if child.skills?.length}<p>
                            <strong>Skills:</strong>
                            {child.skills.join(', ')}
                          </p>{/if}
                      </details>
                    </li>
                  {/each}
                </ol>
              {/if}
            </details>
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{/if}

<style>
  .plan {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
  header {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: start;
  }
  h2,
  p {
    margin-block: 0.4rem;
  }
  ol {
    padding-inline-start: 1.25rem;
  }
  details {
    margin-block: 0.5rem;
  }
  summary {
    cursor: pointer;
    display: grid;
    gap: 0.2rem;
  }
  .measurement {
    color: var(--muted, currentColor);
    font-variant-numeric: tabular-nums;
  }
  .position {
    color: var(--theme-text-muted, currentColor);
    font-variant-numeric: tabular-nums;
  }
  .metadata {
    display: grid;
    gap: 0.25rem;
  }
  .metadata div {
    display: flex;
    gap: 0.5rem;
  }
  .metadata dd {
    margin: 0;
  }
  .close {
    inline-size: 2.75rem;
    block-size: 2.75rem;
    flex: 0 0 auto;
    font-size: 1.5rem;
  }
  button:focus-visible,
  summary:focus-visible {
    outline: 3px solid currentColor;
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      scroll-behavior: auto;
    }
  }
</style>
