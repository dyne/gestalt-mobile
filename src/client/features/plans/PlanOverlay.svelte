<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount, type Snippet } from 'svelte';

  let { children, onclose }: { children: Snippet; onclose: () => void } = $props();
  let dialog: HTMLDialogElement;

  onMount(() => {
    dialog.showModal();
    return () => dialog.close();
  });
</script>

<dialog
  bind:this={dialog}
  class="plan-overlay"
  aria-label="Plan viewer"
  oncancel={(event) => {
    event.preventDefault();
    onclose();
  }}
>
  {@render children()}
</dialog>

<style>
  .plan-overlay {
    box-sizing: border-box;
    inline-size: min(76rem, calc(100% - 1.5rem));
    max-block-size: calc(100dvh - 1.5rem);
    padding: clamp(0.75rem, 3vw, 2rem);
    overflow-y: auto;
    overscroll-behavior: contain;
    color: var(--theme-text);
    background: var(--theme-page);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }

  .plan-overlay::backdrop {
    background: color-mix(in srgb, var(--theme-shadow) 65%, transparent);
  }

  :global(html:has(.plan-overlay[open])) {
    overflow: hidden;
  }
</style>
