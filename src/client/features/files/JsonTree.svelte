<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script lang="ts">
  import { jsonBranches, jsonRows } from './json-tree.js';
  let { text, unfolded = false }: { text: string; unfolded?: boolean } = $props();
  let value = $derived(JSON.parse(text) as unknown);
  let expanded = $derived(unfolded ? jsonBranches(value) : new Set(['']));
  let rows = $derived(jsonRows(value, expanded));
  function toggle(id: string): void {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else {
      for (const child of next) if (child.startsWith(`${id}/`)) next.delete(child);
      next.add(id);
    }
    expanded = next;
  }
</script>

<div class="json-tree" aria-label="JSON contents">
  {#each rows as row (row.id)}
    <div class="json-row" data-kind={row.kind}>
      <span class="fold-column">
        {#if row.expandable}<button
            type="button"
            aria-label={`${row.expanded ? 'Fold' : 'Unfold'} ${row.label}`}
            aria-expanded={row.expanded}
            onclick={() => toggle(row.id)}>{row.expanded ? '−' : '+'}</button
          >{/if}
      </span>
      <code style:padding-inline-start={`${row.depth * 1.2}em`}>{row.text}</code>
    </div>
  {/each}
</div>

<style>
  .json-tree {
    font-size: 0.85rem;
    line-height: 1.65;
  }
  .json-row {
    display: flex;
    align-items: flex-start;
    min-height: 1.8rem;
  }
  .fold-column {
    flex: 0 0 1.8rem;
    position: sticky;
    left: 0;
    align-self: stretch;
    background: var(--theme-surface);
    z-index: 1;
  }
  button {
    width: 1.6rem;
    height: 1.6rem;
    padding: 0;
    border: 1px solid var(--theme-border);
    border-radius: 0.3rem;
    background: var(--theme-surface);
    color: var(--theme-text);
    font: inherit;
    cursor: pointer;
  }
  button:hover {
    color: var(--theme-accent);
    border-color: currentColor;
  }
  button:focus-visible {
    outline: 2px solid var(--theme-accent);
    outline-offset: 1px;
  }
  code {
    white-space: pre;
    padding-block: 0.1rem;
  }
  [data-kind='string'] code {
    color: var(--theme-success);
  }
  [data-kind='number'] code,
  [data-kind='boolean'] code {
    color: var(--theme-accent);
  }
  [data-kind='null'] code {
    color: var(--theme-text-muted);
  }
  @media (pointer: coarse) {
    .json-row {
      min-height: 2.1rem;
    }
    .fold-column {
      flex-basis: 2.1rem;
    }
    button {
      width: 2rem;
      height: 2rem;
    }
  }
</style>
