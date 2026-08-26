<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import type { RelayWorkspaceFile } from '../sessions/relay-client.js';
  import type { FileBrowserController } from './file-browser-controller.js';
  type Node = { entry: RelayWorkspaceFile; level: number; parent: string };
  let {
    controller,
    revision,
    destinationMode = false,
    ondestinationselect = () => {},
    onselectionchange = () => {},
  }: {
    controller: FileBrowserController;
    revision: number;
    destinationMode?: boolean;
    ondestinationselect?: (path: string) => void;
    onselectionchange?: (path: string) => void;
  } = $props();
  let elements = $state<Record<string, HTMLElement>>({});
  let focused = $state('');
  let rootState = $derived.by(() => {
    if (revision < 0) return { entries: [], loading: false, error: false };
    return controller.state('');
  });
  let nodes = $derived.by(() => {
    if (revision < 0) return [];
    const result: Node[] = [];
    const visit = (directory: string, level: number) => {
      for (const entry of controller.state(directory).entries) {
        result.push({ entry, level, parent: directory });
        if (entry.kind === 'directory' && controller.expanded.has(entry.path))
          visit(entry.path, level + 1);
      }
    };
    visit('', 1);
    return result;
  });
  function focus(path: string) {
    focused = path;
    elements[path]?.focus();
  }
  function toggle(entry: RelayWorkspaceFile) {
    if (controller.expanded.has(entry.path)) controller.collapse(entry.path);
    else void controller.expand(entry.path);
  }
  function key(event: KeyboardEvent, node: Node, index: number) {
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
          if (!controller.expanded.has(item.path)) toggle(item);
          else move(index + 1);
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (item.kind === 'directory' && controller.expanded.has(item.path))
          controller.collapse(item.path);
        else if (parent) focus(parent);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        select(item);
        break;
    }
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
  {#if rootState.error}<button type="button" onclick={() => void controller.load('')}
      >Retry loading files</button
    >{/if}
  {#snippet renderDirectory(directoryPath: string, level: number)}
    {#each controller.state(directoryPath).entries as entry (entry.path)}
      {@const directory = entry.kind === 'directory'}
      {@const node = nodes.find((candidate) => candidate.entry.path === entry.path)!}
      {@const index = nodes.findIndex((candidate) => candidate.entry.path === entry.path)}
      <div
        bind:this={elements[entry.path]}
        class:symlink={entry.kind === 'symlink'}
        class="treeitem"
        role="treeitem"
        aria-level={level}
        aria-expanded={directory ? controller.expanded.has(entry.path) : undefined}
        aria-selected={entry.kind === 'symlink' ? 'false' : controller.selectedPath === entry.path}
        aria-disabled={entry.kind === 'symlink'}
        aria-describedby={entry.kind === 'symlink' ? `${entry.path}-unsupported` : undefined}
        tabindex={focused === entry.path || (!focused && index === 0) ? 0 : -1}
        onfocus={() => (focused = entry.path)}
        onkeydown={(event) => key(event, node, index)}
        onclick={() => select(entry)}
      >
        <div class="tree-row" role="presentation" style:--level={level}>
          {#if directory}<button
              class="disclosure"
              type="button"
              aria-label={`${controller.expanded.has(entry.path) ? 'Collapse' : 'Expand'} ${entry.name}`}
              onclick={(event) => {
                event.stopPropagation();
                toggle(entry);
              }}>{controller.expanded.has(entry.path) ? '−' : '+'}</button
            >{:else}<span class="disclosure"></span>{/if}
          <span class="tree-label">{entry.name}</span>{#if destinationMode && !directory}
            <span class="unsupported">Files cannot be destinations</span>
          {:else if entry.kind === 'symlink'}
            <span id={`${entry.path}-unsupported`} class="unsupported">Unsupported link</span>
          {/if}
        </div>
        {#if directory && controller.expanded.has(entry.path)}
          {@const state = controller.state(entry.path)}
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
  {@render renderDirectory('', 1)}
  {#if rootState.cursor}<button type="button" onclick={() => void controller.load('', true)}
      >Load more in root</button
    >{/if}
</div>

<style>
  .file-tree {
    display: grid;
    gap: 0.2rem;
    min-inline-size: 0;
    overflow-x: clip;
  }
  .tree-row {
    display: flex;
    flex-wrap: wrap;
    min-inline-size: 0;
    padding-inline-start: min(calc((var(--level) - 1) * 0.75rem), 4rem);
  }
  button {
    min-block-size: 2.75rem;
    min-inline-size: 2.75rem;
    overflow-wrap: anywhere;
  }
  .treeitem {
    flex: 1;
    text-align: start;
    min-block-size: 2.75rem;
    min-inline-size: 2.75rem;
    overflow-wrap: anywhere;
  }
  .tree-label {
    flex: 1;
  }
  .disclosure {
    flex: 0 0 2.75rem;
  }
  .unsupported {
    color: var(--theme-text-muted);
    font-size: 0.875rem;
  }
</style>
