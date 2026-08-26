<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import type { RelayWorkspaceDirectory } from '../sessions/relay-client.js';
  import FileTree from './FileTree.svelte';
  import { FileBrowserController } from './file-browser-controller.js';

  type Props = {
    root: WorkspaceOption;
    listDirectory: (
      workspaceId: string,
      input?: { directory?: string; cursor?: string; limit?: number },
      signal?: AbortSignal,
    ) => Promise<RelayWorkspaceDirectory>;
    onclose: () => void;
    onerror: (error: unknown) => void;
  };

  let { root, listDirectory, onclose, onerror }: Props = $props();
  let dialog = $state<HTMLDialogElement | null>(null);
  let heading = $state<HTMLHeadingElement | null>(null);
  let revision = $state(0);
  let controller = $state<FileBrowserController | null>(null);
  let rootState = $derived.by(() => {
    revision;
    return controller?.state('') ?? { entries: [], loading: true, error: false };
  });

  const title = $derived(`Files in ${root.relativePath === '.' ? '~/' : `~/${root.relativePath}`}`);

  onMount(async () => {
    controller = new FileBrowserController(root.id, listDirectory, () => (revision += 1), onerror);
    await tick();
    dialog?.showModal();
    heading?.focus();
    void controller.load();
  });

  onDestroy(() => controller?.close());

  function close(): void {
    controller?.close();
    dialog?.close();
  }

  function handleCancel(event: Event): void {
    event.preventDefault();
    close();
  }
</script>

<dialog bind:this={dialog} aria-labelledby="file-browser-title" {onclose} oncancel={handleCancel}>
  <section class="file-browser-shell">
    <header>
      <div>
        <h2 id="file-browser-title" bind:this={heading} tabindex="-1">{title}</h2>
        <p>Browse folders and select a position for future file actions.</p>
      </div>
      <button type="button" class="close" aria-label="Close file browser" onclick={close}>×</button>
    </header>
    <div class="browser-actions">
      <button type="button" onclick={() => void controller?.refresh()} disabled={rootState.loading}
        >Refresh</button
      >
    </div>
    {#if controller && !rootState.loading && rootState.error}
      <section aria-label="File browser error"><p>Files could not be read. Try again.</p></section>
    {:else if controller && !rootState.loading && rootState.entries.length === 0}
      <p role="status">This folder is empty.</p>
    {/if}
    {#if controller}<FileTree {controller} {revision} />{/if}
  </section>
</dialog>

<style>
  dialog {
    inline-size: min(100%, 52rem);
    max-inline-size: 100%;
    max-block-size: 100dvh;
    box-sizing: border-box;
    padding: 0;
    border: 1px solid var(--theme-border);
    border-radius: 0.75rem;
    color: var(--theme-text);
    background: var(--theme-surface);
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.55);
  }
  .file-browser-shell {
    display: grid;
    gap: 1rem;
    max-block-size: calc(100dvh - 1rem);
    padding: 1rem;
    overflow: auto;
  }
  header {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: start;
  }
  h2,
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  header p {
    margin-block-start: 0.35rem;
    color: var(--theme-text-muted);
  }
  button {
    min-block-size: 2.75rem;
    min-inline-size: 2.75rem;
  }
  .close {
    font-size: 1.5rem;
    line-height: 1;
  }
  .browser-actions {
    display: flex;
    gap: 0.5rem;
  }
  @media (max-width: 40rem) {
    dialog {
      inline-size: 100%;
      min-block-size: 100dvh;
      border-radius: 0;
    }
    .file-browser-shell {
      max-block-size: 100dvh;
    }
  }
</style>
