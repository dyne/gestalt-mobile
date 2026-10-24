<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
</script>

<aside class="pending-requests pending-dialogues" aria-label="Pending chat requests">
  {@render children()}
</aside>

<style>
  .pending-requests {
    position: sticky;
    inset-block-start: var(--sticky-header-clearance);
    z-index: 2;
    max-block-size: 55dvh;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--theme-page);
    border-block-end: 1px solid var(--theme-border);
    padding-block-end: 0.5rem;
    margin-block-end: 1rem;
  }
</style>
