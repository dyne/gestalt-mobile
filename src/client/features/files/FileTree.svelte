<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import type { RelayWorkspaceFile } from '../sessions/relay-client.js';
  import type { FileBrowserController } from './file-browser-controller.js';
  type Node = { entry: RelayWorkspaceFile; level: number; parent: string };
  let {
    controller,
    revision,
    directory = '',
    destinationMode = false,
    destination,
    onmanage,
    ondestinationselect = () => {},
    onselectionchange = () => {},
  }: {
    controller: FileBrowserController;
    revision: number;
    directory?: string;
    destinationMode?: boolean;
    destination?: string;
    onmanage?: (path: string) => void;
    ondestinationselect?: (path: string) => void;
    onselectionchange?: (path: string) => void;
  } = $props();
  let elements = $state<Record<string, HTMLElement>>({});
  let focused = $state('');
  let rootState = $derived.by(() => {
    if (revision < 0) return { entries: [], loading: false, error: false };
    return directoryState(directory);
  });
  let nodes = $derived.by(() => {
    if (revision < 0) return [];
    const result: Node[] = [];
    const visit = (directory: string, level: number) => {
      for (const entry of directoryState(directory).entries) {
        result.push({ entry, level, parent: directory });
        if (entry.kind === 'directory' && expanded(entry.path)) visit(entry.path, level + 1);
      }
    };
    visit(directory, 1);
    return result;
  });
  function directoryState(path: string) {
    // The shared controller is a class; revision makes its mutations observable to Svelte.
    void revision;
    return controller.state(path);
  }
  function expanded(path: string): boolean {
    void revision;
    return controller.expanded.has(path);
  }
  function focus(path: string) {
    focused = path;
    elements[path]?.focus();
  }
  function toggle(entry: RelayWorkspaceFile) {
    if (expanded(entry.path)) controller.collapse(entry.path);
    else void controller.expand(entry.path);
  }
  function key(event: KeyboardEvent, node: Node, index: number) {
    if (event.target !== event.currentTarget) return;
    event.stopPropagation();
    const item = node.entry;
    const parent = node.parent;
    const move = (i: number) => {
      const next = nodes[Math.max(0, Math.min(nodes.length - 1, i))];
      if (next) focus(next.entry.path);
    };
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        move(0);
        break;
      case 'End':
        event.preventDefault();
        move(nodes.length - 1);
        break;
      case 'ArrowRight':
        if (item.kind === 'directory') {
          event.preventDefault();
          if (!expanded(item.path)) toggle(item);
          else move(index + 1);
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (item.kind === 'directory' && expanded(item.path)) controller.collapse(item.path);
        else if (parent) focus(parent);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        select(item);
        break;
    }
  }
  function selected(path: string) {
    void revision;
    return (destinationMode ? destination : controller.selectedPath) === path;
  }
  function select(entry: RelayWorkspaceFile): void {
    if (entry.kind === 'symlink') return;
    if (destinationMode) {
      if (entry.kind === 'directory') ondestinationselect(entry.path);
      return;
    }
    controller.select(entry.path);
    onselectionchange(entry.path);
  }
</script>

<div class="file-tree" role="tree" aria-label="Files">
  {#if rootState.loading}<p role="status">Loading files…</p>{/if}
  {#if rootState.error}<button type="button" onclick={() => void controller.load(directory)}
      >Retry loading files</button
    >{/if}
  {#snippet renderDirectory(directoryPath: string, level: number)}
    {#each directoryState(directoryPath).entries as entry (entry.path)}
      {@const directory = entry.kind === 'directory'}
      {@const node = nodes.find((candidate) => candidate.entry.path === entry.path)!}
      {@const index = nodes.findIndex((candidate) => candidate.entry.path === entry.path)}
      <div
        bind:this={elements[entry.path]}
        class:symlink={entry.kind === 'symlink'}
        class="treeitem"
        role="treeitem"
        aria-level={level}
        aria-expanded={directory ? expanded(entry.path) : undefined}
        aria-selected={entry.kind === 'symlink' ? 'false' : selected(entry.path)}
        aria-disabled={entry.kind === 'symlink' || (destinationMode && !directory)}
        aria-describedby={entry.kind === 'symlink' ? `${entry.path}-unsupported` : undefined}
        tabindex={focused === entry.path || (!focused && index === 0) ? 0 : -1}
        onfocus={() => (focused = entry.path)}
        onkeydown={(event) => key(event, node, index)}
        onclick={(event) => {
          event.stopPropagation();
          select(entry);
        }}
      >
        <div class="tree-row" role="presentation" style:--level={level}>
          {#if directory}<button
              class="disclosure"
              type="button"
              aria-label={`${expanded(entry.path) ? 'Collapse' : 'Expand'} ${entry.name}`}
              onclick={(event) => {
                event.stopPropagation();
                toggle(entry);
              }}
              ><span class:expanded={expanded(entry.path)}
                ><Icon name="chevron" size=".85rem" /></span
              ></button
            >{/if}
          <span class="kind-icon" class:folder={directory}
            ><Icon name={directory ? 'sessions' : 'document'} /></span
          >
          <span class="tree-label">{entry.name}</span>{#if destinationMode && !directory}
            <span class="unsupported">Files cannot be destinations</span>
          {:else if entry.kind === 'symlink'}
            <span id={`${entry.path}-unsupported`} class="unsupported">Unsupported link</span>
          {/if}
          {#if onmanage && !destinationMode && entry.kind !== 'symlink'}
            <button
              class="item-menu"
              type="button"
              aria-label={`Actions for ${entry.name}`}
              title={`Actions for ${entry.name}`}
              onclick={(event) => {
                event.stopPropagation();
                controller.select(entry.path);
                onmanage?.(entry.path);
              }}><Icon name="more" size="1.1rem" /></button
            >
          {/if}
        </div>
        {#if directory && expanded(entry.path)}
          {@const state = directoryState(entry.path)}
          <div role="group" aria-label={`Contents of ${entry.name}`}>
            {#if state.loading}<span role="status">Loading…</span>{/if}
            {#if state.error}<button type="button" onclick={() => void controller.load(entry.path)}
                >Retry {entry.name}</button
              >{/if}
            {@render renderDirectory(entry.path, level + 1)}
            {#if state.cursor}<button
                type="button"
                onclick={() => void controller.load(entry.path, true)}
                >Load more in {entry.name}</button
              >{/if}
          </div>
        {/if}
      </div>
    {/each}
  {/snippet}
  {@render renderDirectory(directory, 1)}
  {#if rootState.cursor}<button type="button" onclick={() => void controller.load(directory, true)}
      >Load more in root</button
    >{/if}
</div>

<style>
  .file-tree {
    container-type: inline-size;
    min-inline-size: 0;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 44px;
    padding-inline: min(calc((var(--level) - 1) * 0.85rem + 0.25rem), 3rem) 0.25rem;
    border-bottom: 1px solid var(--theme-divider);
    border-inline-start: 3px solid transparent;
  }
  .treeitem {
    min-inline-size: 0;
    outline-offset: -3px;
  }
  .treeitem[aria-disabled='false'] > .tree-row {
    cursor: pointer;
  }
  .treeitem[aria-disabled='false'] > .tree-row:hover {
    background: var(--theme-control-hover);
  }
  .treeitem[aria-selected='true'] > .tree-row {
    background: var(--theme-accent-wash);
    border-inline-start-color: var(--theme-accent);
  }
  .tree-label {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 0.9375rem;
    line-height: 1.35;
  }
  .disclosure,
  .item-menu {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    flex: none;
    border: 0;
    background: transparent;
    color: var(--theme-text-muted);
    padding: 0;
  }
  .disclosure span {
    display: flex;
  }
  .disclosure .expanded {
    transform: rotate(90deg);
  }
  .item-menu:hover,
  .disclosure:hover {
    background: var(--theme-control-hover);
    color: var(--theme-text);
  }
  .kind-icon {
    display: inline-flex;
    color: var(--theme-text-muted);
  }
  .kind-icon.folder {
    color: var(--theme-accent);
  }
  .kind-icon:first-child {
    margin-inline-start: calc(44px + 0.45rem);
  }
  .unsupported {
    max-inline-size: 35%;
    font-size: 0.75rem;
    color: var(--theme-text-muted);
    overflow-wrap: anywhere;
  }
  @container (max-width: 13rem) {
    .kind-icon {
      display: none;
    }
    .tree-row {
      gap: 4px;
      padding-inline-end: 0;
    }
    .tree-row:has(.kind-icon:first-child) .tree-label {
      margin-inline-start: 44px;
    }
  }
</style>
