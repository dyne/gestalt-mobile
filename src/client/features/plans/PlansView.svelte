<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import AppControl from '../../components/AppControl.svelte';
  import PlanView from './PlanView.svelte';
  import OrgDocumentView from './OrgDocumentView.svelte';
  import type { PlanState } from './plan-controller.js';
  import type { WorkspaceOrgPreview, WorkspacePlanEntry } from '../sessions/relay-client.js';

  export type PlansCatalogState =
    | Readonly<{ kind: 'no-workspace' }>
    | Readonly<{ kind: 'loading'; workspaceId: string }>
    | Readonly<{
        kind: 'ready';
        workspaceId: string;
        entries: readonly WorkspacePlanEntry[];
        refreshing?: boolean;
      }>
    | Readonly<{ kind: 'error'; workspaceId: string; error: string }>;

  type Props = {
    catalog: PlansCatalogState;
    state: PlanState | WorkspaceOrgPreview | null;
    onopen: (planName: string) => void;
    onclose: () => void;
    onarchive?: (planName: string) => void;
    archivingPlans?: readonly string[];
  };

  let {
    catalog,
    state: planState,
    onopen,
    onclose,
    onarchive,
    archivingPlans = [],
  }: Props = $props();
  let heading = $state<HTMLHeadingElement | null>(null);
  let rows = $state<Partial<Record<string, HTMLLIElement>>>({});
  let lastArchived = $state<string | null>(null);
  let lastClosed = $state<string | null>(null);
  let wasViewing = false;
  let restoreFocus = false;
  let unfinishedEntries = $derived(
    catalog.kind === 'ready'
      ? catalog.entries.filter((entry) => entry.allDone !== true && !entry.archived)
      : [],
  );
  let completedEntries = $derived(
    catalog.kind === 'ready'
      ? catalog.entries.filter((entry) => entry.allDone === true || entry.archived)
      : [],
  );

  function close(): void {
    onclose();
  }

  function open(planName: string): void {
    lastClosed = planName;
    onopen(planName);
  }

  function archive(planName: string): void {
    lastArchived = planName;
    onarchive?.(planName);
  }

  $effect(() => {
    const archivedName = lastArchived;
    if (
      archivedName &&
      catalog.kind === 'ready' &&
      catalog.entries.some((entry) => entry.planName === archivedName && entry.archived)
    ) {
      queueMicrotask(() => {
        rows[archivedName]?.querySelector('button')?.focus();
        lastArchived = null;
      });
    }
    if (planState) {
      wasViewing = true;
      return;
    }
    if (wasViewing) {
      wasViewing = false;
      restoreFocus = true;
    }
    if (!restoreFocus) return;
    const catalogKind = catalog.kind;
    const name = lastClosed;
    queueMicrotask(() => {
      const button = name ? rows[name]?.querySelector('button') : undefined;
      if (button?.isConnected) {
        button.focus();
        restoreFocus = false;
      } else if (catalogKind !== 'loading') {
        heading?.focus();
        restoreFocus = false;
      }
    });
  });
</script>

{#snippet planEntry(entry: WorkspacePlanEntry)}
  {@const parts = entry.planName.split('/')}
  {@const folders = parts.slice(0, -1)}
  {@const prefix = folders
    .slice(0, 2)
    .filter((folder, index) => index === 0 || folder !== '.gestalt')
    .join('/')}
  <li
    bind:this={rows[entry.planName]}
    class="plan-row"
    aria-label={`${entry.title} (${entry.planName})`}
  >
    <div class="plan-details">
      <strong>{entry.title}</strong>
      <div class="plan-path" title={entry.planName}>
        {#if prefix}<span>{prefix}</span>{/if}
        <span>{parts.at(-1)}</span>
      </div>
      {#if entry.previewAvailable !== false && entry.totalSteps !== undefined && entry.doneSteps !== undefined}
        <div class="catalog-progress">
          <progress
            aria-label={`Completion for ${entry.title}`}
            value={entry.doneSteps}
            max={Math.max(1, entry.totalSteps)}
            >{entry.doneSteps} of {entry.totalSteps} work items complete</progress
          >
          <span>{entry.doneSteps} / {entry.totalSteps}</span>
        </div>
        {#if entry.subtitle}<span class="subtitle">{entry.subtitle}</span>{/if}
      {:else}
        <span class="subtitle">Org document</span>
      {/if}
      {#if entry.archived}<span class="archive-tag">Archived</span>{/if}
    </div>
    <div class="plan-actions">
      <AppControl label={`Open ${entry.title}`} onclick={() => open(entry.planName)}
        >Open</AppControl
      >
      <AppControl
        label={`Archive ${entry.title}`}
        disabled={!onarchive || entry.archived || archivingPlans.includes(entry.planName)}
        onclick={() => archive(entry.planName)}
        >{archivingPlans.includes(entry.planName) ? 'Archiving…' : 'Archive'}</AppControl
      >
    </div>
  </li>
{/snippet}

{#if planState?.kind === 'org-source'}
  <OrgDocumentView preview={planState} onclose={close} />
{:else if planState}
  <PlanView state={planState} onclose={close} />
{:else}
  <section class="plans" aria-labelledby="plans-title">
    <div class="catalog-heading">
      <h2 id="plans-title" bind:this={heading} tabindex="-1">ORG Plans</h2>
      <span
        class={['catalog-update', { inactive: catalog.kind !== 'ready' || !catalog.refreshing }]}
        role="status"
        aria-hidden={catalog.kind !== 'ready' || !catalog.refreshing}>(updating…)</span
      >
    </div>
    {#if catalog.kind === 'no-workspace'}
      <p>Waiting for the application workspace…</p>
    {:else if catalog.kind === 'loading'}
      <p>Finding Org plans…</p>
    {:else if catalog.kind === 'error'}
      <p>{catalog.error}</p>
    {:else if catalog.entries.length === 0}
      <p>No .org files were found in .gestalt folders below the application workspace.</p>
    {:else}
      <p class="scope">Org plans in .gestalt folders below the application workspace.</p>
      {#if unfinishedEntries.length > 0}
        <ul aria-label="Unfinished plans">
          {#each unfinishedEntries as entry (entry.planName)}
            {@render planEntry(entry)}
          {/each}
        </ul>
      {/if}
      {#if completedEntries.length > 0}
        <section class="completed" aria-labelledby="completed-plans-title">
          <h3 id="completed-plans-title">Completed and archived</h3>
          <ul aria-label="Completed and archived plans">
            {#each completedEntries as entry (entry.planName)}
              {@render planEntry(entry)}
            {/each}
          </ul>
        </section>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .plans {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
  h2 {
    margin-block: 0.4rem;
    min-inline-size: 0;
    font-size: clamp(1rem, 6vw, 1.5rem);
  }
  .scope {
    margin-block: 0 0.75rem;
  }
  ul {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .completed {
    margin-block-start: 1.5rem;
    padding-block-start: 1rem;
    border-block-start: 1px solid var(--theme-border);
  }
  h3 {
    margin-block: 0 0.5rem;
  }
  .catalog-heading {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    min-inline-size: 0;
  }
  .catalog-update {
    color: var(--theme-text-muted);
    font-size: clamp(0.625rem, 3vw, 0.75rem);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .catalog-update.inactive {
    visibility: hidden;
  }
  .plan-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    align-items: start;
    gap: 0.75rem;
    padding-block: 0.75rem;
    border-block-end: 1px solid var(--theme-border);
  }
  .plan-details {
    display: grid;
    gap: 0.35rem;
    min-inline-size: 0;
  }
  .plan-path {
    display: flex;
    flex-wrap: wrap;
    column-gap: 0.75rem;
    color: var(--theme-text-muted);
    font-size: 0.875rem;
  }
  .catalog-progress {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-inline-size: 0;
  }
  progress {
    flex: 1 1 4rem;
    inline-size: 100%;
    min-inline-size: 0;
    block-size: 0.5rem;
    accent-color: var(--theme-accent);
  }
  .catalog-progress span {
    color: var(--theme-text-muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }
  .subtitle,
  .archive-tag {
    color: var(--theme-text-muted);
    font-size: 0.875rem;
  }
  .plan-actions {
    display: grid;
    gap: 0.5rem;
  }
  .plan-actions :global(button) {
    min-block-size: 2.75rem;
    padding: 0.5rem;
    font-size: 0.875rem;
  }
</style>
