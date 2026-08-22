<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import PlanView from './PlanView.svelte';
  import type { PlanState } from './plan-controller.js';
  import type { WorkspaceOrgPreview, WorkspacePlanEntry } from '../sessions/relay-client.js';

  export type PlansCatalogState =
    | Readonly<{ kind: 'no-workspace' }>
    | Readonly<{ kind: 'loading'; workspaceId: string }>
    | Readonly<{ kind: 'ready'; workspaceId: string; entries: readonly WorkspacePlanEntry[] }>
    | Readonly<{ kind: 'error'; workspaceId: string; error: string }>;

  type Props = {
    catalog: PlansCatalogState;
    state: PlanState | WorkspaceOrgPreview | null;
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

{#if planState?.kind === 'org-source'}
  <section class="org-preview" aria-labelledby="org-preview-title">
    <div class="preview-header">
      <div>
        <h2 id="org-preview-title">{planState.title}</h2>
        <code>{planState.planName}</code>
      </div>
      <button type="button" onclick={close}>Close plan and return to list</button>
    </div>
    <p>Org source preview</p>
    <textarea readonly aria-label="Org source" value={planState.source}></textarea>
  </section>
{:else if planState}
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
      <p>No Org files were found below this workspace.</p>
    {:else}
      <p class="scope">Org files below the selected workspace.</p>
      <ul>
        {#each catalog.entries as entry (entry.planName)}
          <li>
            <button bind:this={buttons[entry.planName]} onclick={() => open(entry.planName)}>
              <strong>{entry.title}</strong>
              <code>{entry.planName}</code>
              {#if entry.previewAvailable !== false}
                <span>{entry.doneSteps} / {entry.totalSteps} complete</span>
                {#if entry.subtitle}<span>{entry.subtitle}</span>{/if}
              {:else}
                <span>Org source preview</span>
              {/if}
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
  .plans button {
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
  code {
    font: inherit;
  }
  .org-preview {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
  }
  .preview-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .preview-header h2,
  .org-preview p {
    margin: 0;
  }
  textarea {
    box-sizing: border-box;
    inline-size: 100%;
    max-inline-size: 100%;
    max-block-size: calc(
      100dvh - var(--sticky-header-clearance) - var(--bottom-navigation-clearance)
    );
    min-block-size: 16rem;
    margin: 0;
    padding: 0.75rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 0.5rem;
  }
</style>
