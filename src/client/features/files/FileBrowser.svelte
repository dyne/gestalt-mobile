<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import type { RelayRequestError, RelayWorkspaceDirectory } from '../sessions/relay-client.js';
  import { createIdempotencyKey } from '../sessions/idempotency-key.js';
  import FileTree from './FileTree.svelte';
  import { FileBrowserController } from './file-browser-controller.js';
  import {
    canUseDestination,
    idleTransfer,
    pickDestination,
    startTransfer,
    submitTransfer,
    transferConflict,
    transferFailed,
    type TransferKind,
    type TransferState,
  } from './transfer-state.js';

  type Props = {
    root: WorkspaceOption;
    listDirectory: (
      workspaceId: string,
      input?: { directory?: string; cursor?: string; limit?: number },
      signal?: AbortSignal,
    ) => Promise<RelayWorkspaceDirectory>;
    copyEntry: (
      workspaceId: string,
      input: {
        source: string;
        destinationDirectory: string;
        conflict: 'reject' | 'replace' | 'keep-both';
      },
      key: string,
    ) => Promise<{ path: string; kind: string }>;
    moveEntry: (
      workspaceId: string,
      input: {
        source: string;
        destinationDirectory: string;
        conflict: 'reject' | 'replace' | 'keep-both';
      },
      key: string,
    ) => Promise<{ path: string; kind: string }>;
    deleteEntry: (
      workspaceId: string,
      path: string,
      key: string,
    ) => Promise<{ path: string; kind: string }>;
    onclose: () => void;
    onerror: (error: unknown) => void;
    onsuccess?: (message: string) => void;
  };

  let {
    root,
    listDirectory,
    copyEntry,
    moveEntry,
    deleteEntry,
    onclose,
    onerror,
    onsuccess = () => {},
  }: Props = $props();
  let dialog = $state<HTMLDialogElement | null>(null);
  let heading = $state<HTMLHeadingElement | null>(null);
  let revision = $state(0);
  let controller = $state<FileBrowserController | null>(null);
  let transfer = $state<TransferState>(idleTransfer);
  let conflictPanel = $state<HTMLElement | null>(null);
  let selectedPath = $state('');
  let deleteConfirmation = $state(false);
  let deleting = $state(false);
  let deleteCancel = $state<HTMLButtonElement | null>(null);
  let rootState = $derived.by(() => {
    if (revision < 0) return { entries: [], loading: false, error: false };
    return controller?.state('') ?? { entries: [], loading: true, error: false };
  });
  let selectedEntry = $derived.by(() => {
    if (!controller || !selectedPath) return undefined;
    const parent = selectedPath.includes('/')
      ? selectedPath.slice(0, selectedPath.lastIndexOf('/'))
      : '';
    return controller.state(parent).entries.find((entry) => entry.path === selectedPath);
  });

  const title = $derived(`Files in ${root.relativePath === '.' ? '~/' : `~/${root.relativePath}`}`);

  onMount(async () => {
    controller = new FileBrowserController(
      root.id,
      listDirectory,
      () => {
        revision = revision + 1;
      },
      onerror,
    );
    await tick();
    dialog?.showModal();
    heading?.focus();
    await controller.load();
  });

  onDestroy(() => controller?.close());

  function close(): void {
    if (transfer.phase === 'submitting' || deleting) return;
    controller?.close();
    dialog?.close();
  }

  function handleCancel(event: Event): void {
    if (transfer.phase === 'submitting' || deleting) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    close();
  }
  async function requestDelete(): Promise<void> {
    if (!selectedPath || deleting) return;
    deleting = true;
    try {
      const parent = selectedPath.includes('/')
        ? selectedPath.slice(0, selectedPath.lastIndexOf('/'))
        : '';
      await deleteEntry(root.id, selectedPath, createIdempotencyKey());
      await controller?.refresh(parent);
      controller?.select(parent);
      selectedPath = parent;
      onsuccess('Deleted item.');
      deleteConfirmation = false;
    } catch (error) {
      onerror(error);
    } finally {
      deleting = false;
    }
  }
  async function openDeleteConfirmation(): Promise<void> {
    deleteConfirmation = true;
    await tick();
    deleteCancel?.focus();
  }

  function sourceEntry() {
    return controller
      ?.state(transfer.source ? transfer.source.slice(0, transfer.source.lastIndexOf('/')) : '')
      .entries.find((entry) => entry.path === transfer.source);
  }
  function beginTransfer(kind: TransferKind): void {
    if (!selectedPath) return;
    transfer = startTransfer(kind, selectedPath);
  }
  function chooseDestination(path: string): void {
    if (!canUseDestination(transfer, path)) return;
    transfer = pickDestination(transfer, path);
  }
  async function confirmTransfer(
    conflict: 'reject' | 'replace' | 'keep-both' = 'reject',
  ): Promise<void> {
    if (!controller || (transfer.phase !== 'picking' && transfer.phase !== 'conflict')) return;
    const next =
      transfer.phase === 'picking'
        ? submitTransfer(transfer)
        : { ...transfer, phase: 'submitting' as const };
    if (!next.source || next.destination === undefined || !next.kind) return;
    transfer = next;
    try {
      const execute = next.kind === 'copy' ? copyEntry : moveEntry;
      const result = await execute(
        root.id,
        { source: next.source, destinationDirectory: next.destination, conflict },
        createIdempotencyKey(),
      );
      const sourceParent = next.source.includes('/')
        ? next.source.slice(0, next.source.lastIndexOf('/'))
        : '';
      if (next.kind === 'copy') await controller.refresh(next.destination);
      else {
        await Promise.all([controller.refresh(sourceParent), controller.refresh(next.destination)]);
      }
      controller.select(result.path);
      onsuccess(`${next.kind === 'copy' ? 'Copied' : 'Moved'} ${result.path}.`);
      transfer = idleTransfer;
    } catch (error) {
      const relayError = error as RelayRequestError;
      if (relayError.status === 409) {
        transfer = transferConflict(next, relayError.replaceAllowed === true);
        await tick();
        conflictPanel?.focus();
      } else {
        transfer = transferFailed(next);
        onerror(error);
      }
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="file-browser-title" {onclose} oncancel={handleCancel}>
  <section class="file-browser-shell">
    <header>
      <div>
        <h2 id="file-browser-title" bind:this={heading} tabindex="-1">{title}</h2>
        <p>
          {transfer.phase === 'picking'
            ? 'Choose destination folder.'
            : 'Browse folders and select a position.'}
        </p>
      </div>
      <button type="button" class="close" aria-label="Close file browser" onclick={close}>×</button>
    </header>
    <div class="browser-actions">
      <button type="button" onclick={() => void controller?.refresh()} disabled={rootState.loading}
        >Refresh</button
      >
    </div>
    {#if controller && transfer.phase === 'idle' && selectedEntry && selectedEntry.kind !== 'symlink'}
      <div class="browser-actions" aria-label="Selected file actions">
        <button type="button" onclick={() => beginTransfer('copy')}>Copy</button>
        <button type="button" onclick={() => beginTransfer('move')}>Move</button>
        <button type="button" onclick={() => void openDeleteConfirmation()}>Delete</button>
      </div>
    {/if}
    {#if deleteConfirmation && selectedEntry}
      <section class="picker" aria-label="Delete confirmation" aria-live="assertive">
        <h3>
          {selectedEntry.kind === 'directory' ? 'Delete folder and all contents' : 'Delete file'}
        </h3>
        <p>{selectedPath}</p>
        <div class="browser-actions">
          <button
            bind:this={deleteCancel}
            type="button"
            onclick={() => (deleteConfirmation = false)}
            disabled={deleting}>Cancel</button
          >
          <button type="button" onclick={() => void requestDelete()} disabled={deleting}
            >{deleting ? 'Deleting…' : 'Delete'}</button
          >
        </div>
      </section>
    {/if}
    {#if transfer.phase === 'picking'}
      <section class="picker" aria-label="Choose destination folder" aria-live="polite">
        <p><strong>{transfer.kind === 'copy' ? 'Copy' : 'Move'}:</strong> {transfer.source}</p>
        <p>
          Destination: {transfer.destination === ''
            ? 'root folder'
            : (transfer.destination ?? 'choose a folder')}
        </p>
        <div class="browser-actions">
          <button
            type="button"
            onclick={() => chooseDestination('')}
            disabled={!canUseDestination(transfer, '')}>Use root folder</button
          >
          <button
            type="button"
            onclick={() => void confirmTransfer()}
            disabled={transfer.destination === undefined}>Confirm {transfer.kind}</button
          >
          <button type="button" onclick={() => (transfer = idleTransfer)}>Cancel</button>
        </div>
      </section>
    {:else if transfer.phase === 'conflict'}
      <section
        class="picker"
        bind:this={conflictPanel}
        tabindex="-1"
        aria-label="File conflict"
        aria-live="assertive"
      >
        <h3>Destination already contains this item</h3>
        <p>{transfer.destination}</p>
        <div class="browser-actions">
          {#if transfer.replaceAllowed}<button
              type="button"
              onclick={() => void confirmTransfer('replace')}>Replace</button
            >{/if}
          <button type="button" onclick={() => void confirmTransfer('keep-both')}>Keep both</button>
          <button type="button" onclick={() => (transfer = idleTransfer)}>Cancel</button>
        </div>
      </section>
    {:else if transfer.phase === 'failed'}
      <section class="picker" aria-label="Transfer failed">
        <p role="status">Transfer could not be completed.</p>
        <div class="browser-actions">
          <button type="button" onclick={() => (transfer = { ...transfer, phase: 'picking' })}
            >Try again</button
          ><button type="button" onclick={() => (transfer = idleTransfer)}>Cancel</button>
        </div>
      </section>
    {/if}
    {#if controller && !rootState.loading && rootState.error}
      <section aria-label="File browser error"><p>Files could not be read. Try again.</p></section>
    {:else if controller && !rootState.loading && rootState.entries.length === 0}
      <p role="status">This folder is empty.</p>
    {/if}
    {#if controller}
      {#key revision}
        <FileTree
          {controller}
          {revision}
          destinationMode={transfer.phase === 'picking'}
          ondestinationselect={chooseDestination}
          onselectionchange={(path) => (selectedPath = path)}
        />
      {/key}
    {/if}
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
  .picker {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--theme-border);
    border-radius: 0.5rem;
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
