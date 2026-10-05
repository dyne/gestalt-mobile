<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AppControl from '../../components/AppControl.svelte';
  import JsonTree from './JsonTree.svelte';
  import FileTree from './FileTree.svelte';
  import { FileBrowserController, type DirectoryReader } from './file-browser-controller.js';
  import {
    formatFile,
    markdownPreview,
    relativeFileReference,
    type FilePreview,
    type FileViewerTarget,
  } from './file-preview.js';

  let {
    target,
    readFile,
    listDirectory,
    onclose,
    onerror,
  }: {
    target: FileViewerTarget;
    readFile: (workspaceId: string, path: string, signal?: AbortSignal) => Promise<FilePreview>;
    listDirectory: DirectoryReader;
    onclose: () => void;
    onerror: (error: unknown) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let heading: HTMLHeadingElement;
  let preview = $state<FilePreview | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let source = $state(false);
  let jsonUnfolded = $state(false);
  let revision = $state(0);
  let tree = $state<FileBrowserController | null>(null);
  let history = $state<string[]>([]);
  let currentPath = $state('');
  let formatted = $derived(preview ? formatFile(preview) : { format: 'text', text: '' });
  let html = $derived(
    formatted.format === 'markdown' && !source ? markdownPreview(formatted.text) : '',
  );
  let request: AbortController | null = null;
  let trigger: HTMLElement | null = null;

  async function load(path: string, remember = true): Promise<void> {
    if (remember && preview) history = [...history, preview.path];
    request?.abort();
    tree?.close();
    tree = null;
    const active = new AbortController();
    request = active;
    currentPath = path;
    loading = true;
    failed = false;
    preview = null;
    source = false;
    jsonUnfolded = false;
    try {
      const result = await readFile(target.workspaceId, path, active.signal);
      if (active.signal.aborted) return;
      preview = result;
      currentPath = result.path;
      if (result.kind === 'directory') {
        const controller = new FileBrowserController(
          target.workspaceId,
          listDirectory,
          () => {
            revision += 1;
          },
          onerror,
        );
        tree = controller;
        await controller.load(result.path);
      }
    } catch (error) {
      if (active.signal.aborted) return;
      failed = true;
      onerror(error);
    } finally {
      if (!active.signal.aborted) {
        loading = false;
        await tick();
        heading?.focus();
      }
    }
  }
  function back(): void {
    const path = history.at(-1);
    if (path === undefined) return;
    history = history.slice(0, -1);
    void load(path, false);
  }
  function markdownLink(event: MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const href = anchor?.getAttribute('href');
    if (!href || /^(?:https?:|mailto:|#)/i.test(href)) return;
    event.preventDefault();
    void load(relativeFileReference(currentPath, href));
  }
  // Delegate clicks from native anchors in sanitized Markdown, including keyboard activation.
  function markdownLinks(element: HTMLElement) {
    element.addEventListener('click', markdownLink);
    return { destroy: () => element.removeEventListener('click', markdownLink) };
  }
  onMount(() => {
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    void load(target.path, false);
    return () => {
      request?.abort();
      tree?.close();
      dialog.close();
      trigger?.focus();
    };
  });
</script>

<dialog
  bind:this={dialog}
  class="file-viewer"
  aria-labelledby="file-viewer-title"
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
>
  <header>
    <div class="title">
      <h2 id="file-viewer-title" bind:this={heading} tabindex="-1">
        {currentPath.split('/').filter(Boolean).at(-1) || 'Workspace files'}
      </h2>
      <p>{currentPath || '/'}</p>
    </div>
    <AppControl onclick={onclose} label="Close file preview">Close</AppControl>
  </header>
  <nav aria-label="Preview controls">
    <AppControl onclick={back} disabled={!history.length}>Back</AppControl>
    {#if preview?.kind === 'file' && formatted.format !== 'text'}
      <AppControl
        onclick={() => {
          source = !source;
        }}
        pressed={source}>{source ? 'Show formatted' : 'Show source'}</AppControl
      >
    {/if}
    {#if formatted.format === 'json' && !source}
      <AppControl
        onclick={() => {
          jsonUnfolded = !jsonUnfolded;
        }}
        pressed={jsonUnfolded}
        label={jsonUnfolded ? 'Fold all JSON' : 'Unfold all JSON'}
        >{jsonUnfolded ? 'Unfolded' : 'Folded'}</AppControl
      >
    {/if}
    {#if preview?.kind === 'file'}<span class="format"
        >{formatted.format.toUpperCase()} · {preview.size.toLocaleString()} bytes</span
      >{/if}
  </nav>
  <div class="contents">
    {#if loading}<p role="status">Loading preview…</p>{:else if failed}<p>
        This item could not be opened.
      </p>
      <AppControl onclick={() => void load(currentPath, false)}>Retry</AppControl>
    {:else if preview?.kind === 'directory' && tree}
      <FileTree
        controller={tree}
        {revision}
        directory={preview.path}
        onselectionchange={(path) => {
          const parent = path.split('/').slice(0, -1).join('/');
          const entry = tree?.state(parent).entries.find((item) => item.path === path);
          if (entry?.kind === 'file') void load(path);
          else if (entry?.kind === 'directory') void tree?.expand(path);
        }}
      />
      {#if !tree.state(preview.path).entries.length && !tree.state(preview.path).error}<p
          class="empty"
        >
          This folder is empty.
        </p>{/if}
    {:else if preview?.kind === 'file'}
      {#if html}
        <div class="markdown" use:markdownLinks>{@html html}</div>
      {:else if formatted.format === 'json' && !source}
        <JsonTree text={formatted.text} unfolded={jsonUnfolded} />
      {:else}<pre class:json={formatted.format === 'json'}><code
            >{source ? preview.content : formatted.text}</code
          ></pre>{/if}
    {/if}
  </div>
</dialog>

<style>
  .file-viewer {
    box-sizing: border-box;
    width: min(64rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    padding: 0;
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 1rem;
  }
  .file-viewer[open] {
    display: flex;
    flex-direction: column;
  }
  .file-viewer::backdrop {
    background: rgb(0 0 0 / 55%);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    justify-content: space-between;
    padding: 1.1rem 1.25rem 0.6rem;
  }
  .title {
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 1.2rem;
    overflow-wrap: anywhere;
  }
  .title p {
    margin: 0.35rem 0 0;
    font-size: 0.8rem;
    color: var(--theme-text-muted);
    overflow-wrap: anywhere;
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1.25rem 1rem;
    border-bottom: 1px solid var(--theme-border);
  }
  .format {
    margin-inline-start: auto;
    color: var(--theme-text-muted);
    font-size: 0.75rem;
  }
  .contents {
    min-height: 8rem;
    min-width: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 1.25rem;
  }
  pre {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.6;
    tab-size: 2;
  }
  pre.json {
    color: var(--theme-accent);
  }
  .markdown {
    max-width: 75ch;
    margin-inline: auto;
    overflow-wrap: anywhere;
    line-height: 1.65;
  }
  .markdown :global(:is(h1, h2, h3, h4)) {
    line-height: 1.25;
    margin-block: 1.3em 0.5em;
  }
  .markdown :global(> :first-child) {
    margin-block-start: 0;
  }
  .markdown :global(pre) {
    overflow-x: auto;
    padding: 1rem;
    background: color-mix(in srgb, var(--theme-text) 6%, transparent);
    border-radius: 0.5rem;
  }
  .markdown :global(code) {
    font-size: 0.85em;
  }
  .markdown :global(a) {
    color: var(--theme-accent);
  }
  .markdown :global(blockquote) {
    margin-inline: 0;
    padding-inline-start: 1rem;
    border-inline-start: 3px solid var(--theme-accent);
    color: var(--theme-text-muted);
  }
  .markdown :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  .markdown :global(:is(th, td)) {
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--theme-border);
    text-align: start;
  }
  .empty {
    color: var(--theme-text-muted);
  }
  @media (max-width: 32rem) {
    .file-viewer {
      width: calc(100vw - 0.75rem);
      max-height: calc(100dvh - 0.75rem);
      border-radius: 0.7rem;
    }
    header,
    nav,
    .contents {
      padding-inline: 0.8rem;
    }
  }
</style>
