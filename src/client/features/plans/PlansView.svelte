<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import PlanView from './PlanView.svelte';
  import type { PlanState } from './plan-controller.js';
  import type { WorkspacePlanEntry } from '../sessions/relay-client.js';

  export type PlansCatalogState =
    | Readonly<{ kind: 'no-workspace' }>
    | Readonly<{ kind: 'loading'; workspaceId: string }>
    | Readonly<{ kind: 'ready'; workspaceId: string; entries: readonly WorkspacePlanEntry[] }>
    | Readonly<{ kind: 'error'; workspaceId: string; error: string }>;

  type Props = {
    catalog: PlansCatalogState;
    state: PlanState | null;
    onopen: (planName: string) => void;
    onclose: () => void;
  };

  let { catalog, state: planState, onopen, onclose }: Props = $props();
  let heading = $state<HTMLHeadingElement | null>(null);
  let buttons = $state<Partial<Record<string, HTMLButtonElement>>>({});
  let lastClosed = $state<string | null>(null);
  let wasViewing = false;
  let restoreFocus = false;

  function close(): void {
    onclose();
  }

  function open(planName: string): void {
    lastClosed = planName;
    onopen(planName);
  }

  $effect(() => {
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
      const button = name ? buttons[name] : undefined;
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

{#if planState}
  <PlanView state={planState} onclose={close} />
{:else}
  <section class="plans" aria-labelledby="plans-title">
    <h2 id="plans-title" bind:this={heading} tabindex="-1">Plans</h2>
    {#if catalog.kind === 'no-workspace'}
      <p>Select a workspace to browse its local plans.</p>
    {:else if catalog.kind === 'loading'}
      <p>Loading workspace plans…</p>
    {:else if catalog.kind === 'error'}
      <p>{catalog.error}</p>
    {:else if catalog.entries.length === 0}
      <p>No local plans are available in this workspace.</p>
    {:else}
      <ul>
        {#each catalog.entries as entry (entry.planName)}
          <li>
            <button bind:this={buttons[entry.planName]} onclick={() => open(entry.planName)}>
              <strong>{entry.title}</strong>
              <span>{entry.planName}</span>
              <span>{entry.doneSteps} / {entry.totalSteps} complete</span>
              {#if entry.subtitle}<span>{entry.subtitle}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
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
  }
  ul {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  button {
    display: grid;
    inline-size: 100%;
    min-block-size: 2.75rem;
    gap: 0.2rem;
    padding: 0.75rem;
    text-align: start;
  }
  button:focus-visible {
    outline: 3px solid currentColor;
    outline-offset: 2px;
  }
</style>
