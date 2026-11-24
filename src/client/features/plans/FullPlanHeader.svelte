<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import type { Snippet } from 'svelte';
  import PlanFilePath from './PlanFilePath.svelte';

  let {
    title,
    titleId,
    sourcePath,
    oncopyresult,
    executeAction,
    closeLabel,
    onclose,
  }: {
    title: string;
    titleId: string;
    sourcePath?: string;
    oncopyresult?: (copied: boolean) => void;
    executeAction?: Snippet;
    closeLabel: string;
    onclose: () => void;
  } = $props();
</script>

<header>
  <h2 id={titleId}>{title}</h2>
  <button class="close" type="button" aria-label={closeLabel} title={closeLabel} onclick={onclose}
    ><Icon name="close" /></button
  >
  {#if sourcePath}<PlanFilePath path={sourcePath} {oncopyresult} />{/if}
  {#if executeAction}<div class="actions">{@render executeAction()}</div>{/if}
</header>

<style>
  header {
    margin-block-end: 0.75rem;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    align-items: start;
    column-gap: 0.5rem;
  }
  header > :global(.plan-file-path),
  .actions {
    grid-column: 1 / -1;
  }
  h2 {
    margin: 0;
    font: 600 clamp(1.375rem, 2.5vw, 1.875rem) / 1.2 var(--theme-font-display);
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  button {
    inline-size: 44px;
    min-block-size: 44px;
    padding: 0;
    font-size: 1.5rem;
    line-height: 1;
  }
</style>
