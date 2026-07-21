<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
  import {
    flattenVisibleTree,
    toggleExpanded,
    type TreeNodePolicy,
    type VisibleTreeNode,
  } from './tree-state.js';

  type Props = {
    roots: WorkspaceOption[];
    expandedIds: ReadonlySet<string>;
    selectedId: string | null;
    isSelectable?: TreeNodePolicy;
    label: string;
    onexpandedchange: (expandedIds: Set<string>) => void;
    onselect: (node: WorkspaceOption) => void;
  };

  let {
    roots,
    expandedIds,
    selectedId,
    isSelectable = () => true,
    label,
    onexpandedchange,
    onselect,
  }: Props = $props();

  let focusedId = $state<string | null>(null);
  const itemElements = $state<Record<string, HTMLButtonElement>>({});
  let visibleNodes = $derived(flattenVisibleTree(roots, expandedIds));
  let activeFocusId = $derived.by(() => {
    if (focusedId && visibleNodes.some(({ node }) => node.id === focusedId)) return focusedId;
    if (selectedId && visibleNodes.some(({ node }) => node.id === selectedId)) return selectedId;
    return visibleNodes[0]?.node.id ?? null;
  });

  function isExpandable(node: WorkspaceOption): boolean {
    return !node.isGitRepository && node.children.length > 0;
  }

  function shortPath(relativePath: string): string {
    return relativePath === '.' ? '~/' : `~/${relativePath}`;
  }

  function focusNode(nodeId: string): void {
    focusedId = nodeId;
    itemElements[nodeId]?.focus();
  }

  function moveFocus(currentIndex: number, nextIndex: number): void {
    const boundedIndex = Math.max(0, Math.min(visibleNodes.length - 1, nextIndex));
    const next = visibleNodes[boundedIndex];
    if (next && boundedIndex !== currentIndex) focusNode(next.node.id);
  }

  function selectNode(node: WorkspaceOption): void {
    if (isSelectable(node)) onselect(node);
  }

  function toggleNode(node: WorkspaceOption): void {
    if (isExpandable(node)) onexpandedchange(toggleExpanded(expandedIds, node));
  }

  function handleKeydown(event: KeyboardEvent, item: VisibleTreeNode, index: number): void {
    const { node, parentId } = item;
    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(index, index - 1);
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(index, index + 1);
        break;
      case 'ArrowRight':
        if (!isExpandable(node)) return;
        event.preventDefault();
        if (!expandedIds.has(node.id)) toggleNode(node);
        else if (visibleNodes[index + 1]?.parentId === node.id) moveFocus(index, index + 1);
        break;
      case 'ArrowLeft':
        if (!expandedIds.has(node.id) && !parentId) return;
        event.preventDefault();
        if (isExpandable(node) && expandedIds.has(node.id)) toggleNode(node);
        else if (parentId) focusNode(parentId);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(index, 0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(index, visibleNodes.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        selectNode(node);
        break;
    }
  }
</script>

<div class="filesystem-tree" role="tree" aria-label={label}>
  {#each visibleNodes as item, index (item.node.id)}
    {@const node = item.node}
    {@const expandable = isExpandable(node)}
    <div class="tree-row" style:--tree-level={Math.min(item.level - 1, 6)}>
      {#if expandable}
        <button
          class="disclosure"
          type="button"
          tabindex="-1"
          aria-label={`${expandedIds.has(node.id) ? 'Collapse' : 'Expand'} ${node.name}`}
          onclick={() => toggleNode(node)}
        >
          <span aria-hidden="true">{expandedIds.has(node.id) ? '−' : '+'}</span>
        </button>
      {:else}
        <span class="disclosure-spacer" aria-hidden="true"></span>
      {/if}
      <button
        bind:this={itemElements[node.id]}
        class="tree-item"
        class:selected={selectedId === node.id}
        class:repository={node.isGitRepository}
        type="button"
        role="treeitem"
        aria-level={item.level}
        aria-expanded={expandable ? expandedIds.has(node.id) : undefined}
        aria-selected={selectedId === node.id}
        aria-disabled={!isSelectable(node)}
        tabindex={activeFocusId === node.id ? 0 : -1}
        title={shortPath(node.relativePath)}
        onfocus={() => (focusedId = node.id)}
        onkeydown={(event) => handleKeydown(event, item, index)}
        onclick={() => selectNode(node)}
      >
        <span class="selection-mark" aria-hidden="true">{selectedId === node.id ? '✓' : ''}</span>
        <span class="node-copy">
          <span class="node-name">{node.name}</span>
          <span class="node-path">{shortPath(node.relativePath)}</span>
        </span>
        {#if node.isGitRepository}<span class="repository-badge">Git</span>{/if}
      </button>
    </div>
  {/each}
</div>

<style>
  .filesystem-tree {
    display: grid;
    inline-size: 100%;
    max-inline-size: 100%;
    overflow-x: clip;
  }

  .tree-row {
    display: flex;
    align-items: stretch;
    min-inline-size: 0;
    padding-inline-start: min(calc(var(--tree-level) * 0.75rem), 4.5rem);
  }

  .disclosure,
  .disclosure-spacer {
    flex: 0 0 44px;
    inline-size: 44px;
    min-block-size: 44px;
  }

  .disclosure {
    display: grid;
    place-items: center;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: 0.35rem;
    font: inherit;
    font-size: 1.25rem;
    font-weight: 700;
  }

  .disclosure:hover {
    background: color-mix(in srgb, CanvasText 10%, transparent);
  }

  .tree-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-inline-size: 0;
    min-block-size: 44px;
    flex: 1 1 auto;
    padding: 0.3rem 0.5rem;
    overflow: hidden;
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    font: inherit;
    text-align: start;
  }

  .tree-item:hover {
    background: color-mix(in srgb, CanvasText 8%, transparent);
  }

  .tree-item.selected {
    background: color-mix(in srgb, Highlight 16%, Canvas);
    border-color: currentColor;
    font-weight: 650;
  }

  .tree-item[aria-disabled='true'] {
    opacity: 0.58;
  }

  .tree-item.repository {
    border-inline-start-width: 3px;
  }

  .selection-mark {
    flex: 0 0 1rem;
    inline-size: 1rem;
    text-align: center;
  }

  .node-copy {
    display: grid;
    min-inline-size: 0;
    flex: 1 1 auto;
  }

  .node-name,
  .node-path {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node-path {
    font-size: 0.75em;
    font-weight: 400;
    opacity: 0.72;
  }

  .repository-badge {
    flex: 0 0 auto;
    padding: 0.1rem 0.35rem;
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 0.72em;
    font-weight: 700;
    line-height: 1.2;
  }

  @media (max-width: 24rem) {
    .tree-row {
      padding-inline-start: min(calc(var(--tree-level) * 0.5rem), 3rem);
    }

    .tree-item {
      gap: 0.35rem;
      padding-inline: 0.35rem;
    }
  }

  @media (forced-colors: active) {
    .tree-item.selected,
    .tree-item.repository,
    .repository-badge {
      border-color: CanvasText;
    }
  }
</style>
