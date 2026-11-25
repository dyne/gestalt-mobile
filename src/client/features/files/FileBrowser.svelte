<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { onDestroy, onMount, tick } from 'svelte';
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import type { RelayRequestError, RelayWorkspaceDirectory } from '../sessions/relay-client.js';
  import { createIdempotencyKey } from '../sessions/idempotency-key.js';
  import FileTree from './FileTree.svelte';
  import { FileBrowserController } from './file-browser-controller.js';
  import {
    initialiseUploads,
    MAX_UPLOAD_BYTES,
    nextUpload,
    type UploadOutcome,
  } from './upload-state.js';
  import {
    canUseDestination,
    idleTransfer,
    pickDestination,
    parent as parentPath,
    startTransfer,
    submitTransfer,
    transferConflict,
    transferFailed,
    type TransferKind,
    type TransferState,
  } from './transfer-state.js';

  type Props = {
    root: WorkspaceOption;
    createDirectory?: (
      workspaceId: string,
      input: { directory: string; name: string },
      key: string,
    ) => Promise<{ path: string }>;
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
        newName?: string;
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
    uploadFile: (
      workspaceId: string,
      input: {
        directory: string;
        filename: string;
        conflict: 'reject' | 'replace' | 'keep-both';
        file: File;
      },
      key: string,
      signal?: AbortSignal,
    ) => Promise<{ path: string; kind: string }>;
    onview?: (path: string) => void;
    onclose: () => void;
    onerror: (error: unknown) => void;
    onsuccess?: (message: string) => void;
    onmutation?: () => void;
  };

  let {
    root,
    createDirectory,
    listDirectory,
    copyEntry,
    moveEntry,
    deleteEntry,
    uploadFile,
    onclose,
    onview,
    onerror,
    onsuccess = () => {},
    onmutation = () => {},
  }: Props = $props();
  let dialog = $state<HTMLDialogElement | null>(null);
  let heading = $state<HTMLHeadingElement | null>(null);
  let revision = $state(0);
  let controller = $state<FileBrowserController | null>(null);
  let transfer = $state<TransferState>(idleTransfer);
  let conflictPanel = $state<HTMLElement | null>(null);
  let selectedPath = $state('');
  let newFolderParent = $state<string | null>(null);
  let folderName = $state('');
  let renamePath = $state<string | null>(null);
  let newName = $state('');
  let renameError = $state('');
  let renaming = $state(false);
  let renameInput = $state<HTMLInputElement>();
  let itemActions = $state<HTMLElement>();

  let creatingFolder = $state(false);
  let folderNameInput = $state<HTMLInputElement | null>(null);
  let newFolderButton = $state<HTMLButtonElement | null>(null);
  let deleteConfirmation = $state(false);
  const editing = $derived(renamePath !== null || newFolderParent !== null || deleteConfirmation);
  let deleting = $state(false);
  let deleteCancel = $state<HTMLButtonElement | null>(null);
  let uploadInput = $state<HTMLInputElement | null>(null);
  let uploadOutcomes = $state<UploadOutcome[]>([]);
  let uploading = $state(false);
  let uploadAbort = $state<AbortController | null>(null);
  let uploadConflict = $state<{ index: number; replaceAllowed: boolean } | null>(null);
  let rootState = $derived.by(() => {
    if (revision < 0) return { entries: [], loading: false, error: false };
    return controller?.state('') ?? { entries: [], loading: true, error: false };
  });
  let selectedEntry = $derived.by(() => {
    void revision;
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
    if (transfer.phase === 'submitting' || deleting || creatingFolder || renaming) return;
    uploadAbort?.abort();
    controller?.close();
    dialog?.close();
  }
  const selectedDirectory = $derived(
    selectedEntry?.kind === 'directory' || !selectedPath ? selectedPath : '',
  );
  const uploadDestination = $derived(selectedDirectory || '');

  async function openNewFolder(): Promise<void> {
    newFolderParent = selectedDirectory;
    folderName = '';
    await tick();
    folderNameInput?.focus();
  }

  async function cancelNewFolder(): Promise<void> {
    if (creatingFolder) return;
    newFolderParent = null;
    await tick();
    newFolderButton?.focus();
  }

  async function createFolder(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (creatingFolder || newFolderParent === null || !createDirectory || !controller) return;
    const directory = newFolderParent;
    const name = folderName.trim();
    if (!name) return;
    creatingFolder = true;
    try {
      const result = await createDirectory(root.id, { directory, name }, createIdempotencyKey());
      await controller.refresh(directory);
      await controller.expand(directory);
      controller.select(result.path);
      selectedPath = result.path;
      newFolderParent = null;
      onmutation();
      onsuccess(`Created folder ${name}.`);
    } catch (error) {
      onerror(
        Object.assign(new Error('WORKSPACE_FOLDER_CREATE_FAILED'), {
          code:
            (error as RelayRequestError).status === 409
              ? 'WORKSPACE_FOLDER_EXISTS'
              : 'WORKSPACE_FOLDER_CREATE_FAILED',
        }),
      );
    } finally {
      creatingFolder = false;
      await tick();
      if (newFolderParent === null) newFolderButton?.focus();
      else folderNameInput?.focus();
    }
  }
  async function uploadQueue(
    conflict: 'reject' | 'replace' | 'keep-both' = 'reject',
  ): Promise<void> {
    if (uploading || !controller) return;
    uploading = true;
    try {
      for (;;) {
        const index = uploadConflict?.index ?? nextUpload(uploadOutcomes);
        uploadConflict = null;
        if (index < 0) break;
        const outcome = uploadOutcomes[index];
        if (!outcome || outcome.status === 'too-large') continue;
        uploadOutcomes = uploadOutcomes.map((item, position) =>
          position === index ? { ...item, status: 'uploading' } : item,
        );
        const abort = new AbortController();
        uploadAbort = abort;
        try {
          const result = await uploadFile(
            root.id,
            {
              directory: uploadDestination,
              filename: outcome.file.name,
              conflict,
              file: outcome.file,
            },
            createIdempotencyKey(),
            abort.signal,
          );
          uploadOutcomes = uploadOutcomes.map((item, position) =>
            position === index ? { ...item, status: 'completed', path: result.path } : item,
          );
          await controller.refresh(uploadDestination);
          controller.select(uploadDestination);
          selectedPath = uploadDestination;
          onmutation();
          conflict = 'reject';
        } catch (error) {
          const relayError = error as RelayRequestError;
          if (relayError.status === 409) {
            uploadOutcomes = uploadOutcomes.map((item, position) =>
              position === index ? { ...item, status: 'queued' } : item,
            );
            uploadConflict = { index, replaceAllowed: relayError.replaceAllowed === true };
            break;
          }
          uploadOutcomes = uploadOutcomes.map((item, position) =>
            position === index
              ? { ...item, status: abort.signal.aborted ? 'cancelled' : 'failed' }
              : item,
          );
          onerror(error);
        } finally {
          uploadAbort = null;
        }
      }
    } finally {
      uploading = false;
      const completed = uploadOutcomes.filter((outcome) => outcome.status === 'completed').length;
      if (completed) onsuccess(`Uploaded ${completed} file${completed === 1 ? '' : 's'}.`);
    }
  }
  function pickUploads(files: FileList | null): void {
    if (!files || files.length === 0) return;
    uploadOutcomes = initialiseUploads(files);
    void uploadQueue();
  }
  function cancelRemainingUploads(): void {
    uploadAbort?.abort();
    uploadOutcomes = uploadOutcomes.map((outcome) =>
      outcome.status === 'queued' || outcome.status === 'uploading'
        ? { ...outcome, status: 'cancelled' }
        : outcome,
    );
    uploadConflict = null;
  }

  function handleCancel(event: Event): void {
    if (transfer.phase === 'submitting' || deleting || creatingFolder || renaming) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (renamePath !== null) {
      void cancelRename();
      return;
    }
    if (newFolderParent !== null) {
      void cancelNewFolder();
      return;
    }
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
      onmutation();
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

  async function manage(path: string) {
    selectedPath = path;
    await tick();
    itemActions?.focus();
  }
  async function openRename() {
    if (!selectedEntry) return;
    renamePath = selectedPath;
    newName = selectedEntry.name;
    renameError = '';
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }
  async function cancelRename() {
    if (renaming) return;
    renamePath = null;
    await tick();
    itemActions?.focus();
  }
  async function renameSelected(event: SubmitEvent) {
    event.preventDefault();
    if (renaming || !renamePath || !controller || !newName.trim()) return;
    const source = renamePath;
    const directory = parentPath(source);
    renaming = true;
    renameError = '';
    try {
      const result = await moveEntry(
        root.id,
        { source, destinationDirectory: directory, newName, conflict: 'reject' },
        createIdempotencyKey(),
      );
      await controller.refresh(directory);
      selectedPath = result.path;
      controller.select(result.path);
      renamePath = null;
      onmutation();
      onsuccess(`Renamed to ${newName}.`);
    } catch (error) {
      const code = (error as RelayRequestError).code;
      renameError =
        code === 'FILE_CONFLICT' || code === 'SYMLINK_UNSUPPORTED'
          ? 'That name is already in use. Choose another name.'
          : 'Could not rename this item. Check the name and try again.';
    } finally {
      renaming = false;
      await tick();
      if (renamePath !== null) renameInput?.focus();
      else itemActions?.focus();
    }
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
      const sourceParent = parentPath(next.source);
      if (next.kind === 'move' && sourceParent !== next.destination)
        await controller.refresh(sourceParent);
      await controller.refresh(next.destination);
      await controller.expand(next.destination);
      selectedPath = result.path;
      controller.select(result.path);
      onsuccess(`${next.kind === 'copy' ? 'Copied' : 'Moved'} ${result.path}.`);
      onmutation();
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
      <div class="workspace-heading">
        <span class="workspace-icon"><Icon name="sessions" size="1.5rem" /></span>
        <div>
          <h2 id="file-browser-title" aria-label={title} bind:this={heading} tabindex="-1">
            Files
          </h2>
          <p class="workspace-path">
            {root.relativePath === '.' ? '~/' : `~/${root.relativePath}`}
          </p>
        </div>
      </div>
      <div class="header-tools">
        <button
          type="button"
          onclick={() => void controller?.refresh()}
          disabled={rootState.loading ||
            editing ||
            uploading ||
            uploadConflict !== null ||
            transfer.phase !== 'idle'}
          class="refresh"
          aria-label="Refresh"
          title="Refresh"><Icon name="refresh" /></button
        >
        <button
          type="button"
          class="close"
          aria-label="Close file browser"
          title="Close file browser"
          onclick={close}><Icon name="close" /></button
        >
      </div>
    </header>
    <div
      class="browser-actions toolbar"
      inert={editing || uploading || uploadConflict !== null || transfer.phase !== 'idle'}
    >
      {#if createDirectory}
        <button
          bind:this={newFolderButton}
          type="button"
          onclick={() => void openNewFolder()}
          disabled={rootState.loading ||
            newFolderParent !== null ||
            creatingFolder ||
            uploading ||
            deleting ||
            transfer.phase !== 'idle' ||
            (selectedEntry !== undefined && selectedEntry.kind !== 'directory')}
          ><Icon name="folder-add" />New folder</button
        >
      {/if}
      <input
        bind:this={uploadInput}
        class="visually-hidden"
        type="file"
        multiple
        aria-label="Choose files to upload"
        onchange={(event) => pickUploads(event.currentTarget.files)}
      />
      <button
        class="upload"
        type="button"
        onclick={() => uploadInput?.click()}
        disabled={selectedEntry?.kind === 'file' || uploading}
        ><Icon name="upload" />Upload files</button
      >
    </div>
    {#if newFolderParent !== null}
      <form class="picker" aria-label="New folder" onsubmit={createFolder}>
        <p>Create in: {newFolderParent || 'root folder'}</p>
        <label for="new-folder-name">Folder name</label>
        <input
          bind:this={folderNameInput}
          id="new-folder-name"
          bind:value={folderName}
          required
          maxlength="255"
          disabled={creatingFolder}
        />
        <div class="browser-actions">
          <button type="submit" disabled={creatingFolder || !folderName.trim()}
            >{creatingFolder ? 'Creating…' : 'Create folder'}</button
          >
          <button type="button" disabled={creatingFolder} onclick={() => void cancelNewFolder()}
            >Cancel</button
          >
        </div>
      </form>
    {/if}
    {#if uploadOutcomes.length}
      <section class="picker" aria-label="Upload queue" aria-live="polite">
        <p>
          {uploadOutcomes.filter((item) => item.status === 'queued').length} queued, {uploadOutcomes.filter(
            (item) => item.status === 'completed',
          ).length} completed
        </p>
        <ul>
          {#each uploadOutcomes as outcome (outcome.file)}<li>
              {outcome.file.name}: {outcome.path ?? outcome.status}{outcome.status === 'too-large'
                ? ` (maximum ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB)`
                : ''}
            </li>{/each}
        </ul>
        {#if uploadConflict}
          <div class="browser-actions" aria-label="Upload conflict">
            {#if uploadConflict.replaceAllowed}<button
                type="button"
                onclick={() => void uploadQueue('replace')}>Replace</button
              >{/if}
            <button type="button" onclick={() => void uploadQueue('keep-both')}>Keep both</button>
            <button type="button" onclick={cancelRemainingUploads}>Cancel remaining</button>
          </div>
        {:else if uploading}<button type="button" onclick={cancelRemainingUploads}
            >Cancel uploads</button
          >{/if}
      </section>
    {/if}
    {#if controller && transfer.phase === 'idle' && selectedEntry && selectedEntry.kind !== 'symlink' && !editing}
      <section
        class="selection"
        inert={uploading || uploadConflict !== null}
        tabindex="-1"
        bind:this={itemActions}
        aria-label="Selected file actions"
      >
        <div class="selection-title">
          <strong>{selectedPath}</strong>
          <button
            aria-label="Clear selection"
            title="Clear selection"
            onclick={() => {
              selectedPath = '';
              controller?.select('');
              heading?.focus();
            }}><Icon name="close" size="1rem" /></button
          >
        </div>
        <div class="browser-actions item-tools">
          {#if onview}<button type="button" onclick={() => onview?.(selectedPath)}
              ><Icon name="open" />View</button
            >{/if}
          <button type="button" onclick={() => beginTransfer('copy')}
            ><Icon name="copy" />Copy</button
          >
          <button type="button" onclick={() => beginTransfer('move')}
            ><Icon name="move" />Move</button
          >
          <button type="button" onclick={() => void openRename()}
            ><Icon name="rename" />Rename</button
          >
          <button class="danger" type="button" onclick={() => void openDeleteConfirmation()}
            ><Icon name="clean" />Delete</button
          >
        </div>
      </section>
    {/if}
    {#if renamePath !== null}
      <form class="picker" aria-label="Rename item" onsubmit={renameSelected}>
        <label for="rename-file">New name</label>
        <input
          id="rename-file"
          bind:this={renameInput}
          bind:value={newName}
          required
          maxlength="255"
          disabled={renaming}
          aria-describedby={renameError ? 'rename-error' : undefined}
          oninput={() => (renameError = '')}
        />
        {#if renameError}<p id="rename-error" role="alert">{renameError}</p>{/if}
        <div class="browser-actions">
          <button
            class="primary"
            type="submit"
            disabled={renaming ||
              !newName.trim() ||
              newName === renamePath.split('/').at(-1) ||
              /[/\\]/.test(newName)}>{renaming ? 'Renaming…' : 'Rename'}</button
          >
          <button type="button" disabled={renaming} onclick={() => void cancelRename()}
            >Cancel</button
          >
        </div>
      </form>
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
        {#if transfer.kind === 'copy' && selectedEntry?.kind === 'directory'}<p class="copy-note">
            Skips temporary folders, caches, dependencies and build output.
          </p>{/if}
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
      <div
        class="listing"
        inert={editing ||
          uploading ||
          uploadConflict !== null ||
          transfer.phase === 'submitting' ||
          transfer.phase === 'conflict'}
      >
        <FileTree
          {controller}
          {revision}
          destinationMode={transfer.phase === 'picking'}
          destination={transfer.destination}
          onmanage={manage}
          ondestinationselect={chooseDestination}
          onselectionchange={async (path) => {
            selectedPath = path;
            const parent = path.split('/').slice(0, -1).join('/');
            const entry = controller?.state(parent).entries.find((item) => item.path === path);
            if (entry?.kind !== 'file' || !onview || deleteConfirmation) return;
            await tick();
            if (selectedPath !== path || transfer.phase !== 'idle' || !dialog?.open) return;
            dialog?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')?.focus();
            onview(path);
          }}
        />
      </div>
    {/if}
  </section>
</dialog>

<style>
  dialog {
    inline-size: min(100%, 52rem);
    max-inline-size: 100%;
    max-block-size: 100dvh;
    box-sizing: border-box;
    overflow-x: hidden;
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
    gap: 0;
    max-block-size: calc(100dvh - 1rem);
    padding: 0;
    overflow: auto;
    overflow-x: hidden;
    min-inline-size: 0;
  }
  header {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: start;
  }
  header > div,
  .picker {
    min-inline-size: 0;
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
    min-block-size: clamp(44px, 2.75rem, 56px);
    min-inline-size: 2.75rem;
  }
  .close {
    font-size: 1.5rem;
    line-height: 1;
  }
  .browser-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .visually-hidden {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .picker {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--theme-border);
    border-radius: 0.5rem;
  }
  header {
    padding: 1rem 1.15rem;
    align-items: center;
    background: var(--theme-surface);
  }
  .workspace-heading {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
  }
  .workspace-heading > div {
    min-width: 0;
  }
  .workspace-icon {
    width: 2.65rem;
    height: 2.65rem;
    display: grid;
    place-items: center;
    flex: none;
    background: var(--theme-accent-wash);
    color: var(--theme-accent);
    border-radius: 0.65rem;
  }
  header h2 {
    font: 650 1.4rem / 1.15 var(--theme-font-display);
    letter-spacing: -0.02em;
  }
  .workspace-path {
    font: 0.8125rem / 1.4 var(--theme-font-code);
    margin-top: 0.15rem;
  }
  .close,
  .refresh,
  .selection-title button {
    display: grid;
    place-items: center;
    background: transparent;
    color: var(--theme-text-muted);
    border: 0;
    padding: 0;
  }
  .toolbar {
    border-block: 1px solid var(--theme-divider);
    padding: 0.4rem 0.8rem;
    background: var(--theme-surface-subtle);
    align-items: center;
    gap: 0.25rem;
  }
  .toolbar button,
  .item-tools button {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    justify-content: center;
  }
  .toolbar button:not(.refresh),
  .item-tools button {
    padding: 0.35rem 0.6rem;
    font-size: 0.875rem;
    border-color: transparent;
    background: transparent;
  }
  .toolbar button {
    white-space: nowrap;
  }
  .toolbar .upload {
    color: var(--theme-accent);
    font-weight: 650;
  }
  .header-tools {
    display: flex;
    flex: none;
  }
  .header-tools button {
    width: 44px;
    min-width: 44px;
    height: 44px;
    min-height: 44px;
  }
  .toolbar button:hover:enabled,
  .item-tools button:hover:enabled,
  .close:hover {
    background: var(--theme-control-hover);
  }
  .selection {
    padding: 0.4rem 0.8rem;
    border-bottom: 1px solid var(--theme-divider);
    background: var(--theme-accent-wash);
  }
  .selection-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font: 0.875rem var(--theme-font-code);
    overflow-wrap: anywhere;
  }
  .item-tools {
    gap: 0 0.25rem;
  }
  .item-tools .danger,
  #rename-error {
    color: var(--theme-error);
  }
  .listing {
    padding: 0.35rem 0.7rem 1rem;
    min-height: 10rem;
  }
  .picker {
    margin: 0.6rem 0.8rem;
    background: var(--theme-surface-subtle);
  }
  .picker input {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  .copy-note {
    font-size: 0.875rem;
    color: var(--theme-text-muted);
  }
  .primary {
    background: var(--theme-accent);
    color: var(--theme-accent-contrast);
  }
  .file-browser-shell > p,
  .file-browser-shell > section[aria-label='File browser error'] {
    padding: 0.8rem 1rem;
  }
  @media (max-width: 380px) {
    .workspace-icon {
      display: none;
    }
    header {
      gap: 8px;
      padding-inline: 12px;
    }
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
