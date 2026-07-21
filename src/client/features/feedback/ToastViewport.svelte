<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { visibleToastLimit, type Toast, type ToastQueue } from './toast-queue.js';

  let { queue }: { queue: ToastQueue } = $props();
  let toasts = $state.raw<Toast[]>([]);
  let visibleToasts = $derived(toasts.slice(-visibleToastLimit));

  onMount(() => queue.subscribe((value) => (toasts = value)));
</script>

<div class="toast-viewport" aria-label="Notifications">
  {#each visibleToasts as toast (toast.id)}
    <section
      class:error={toast.kind === 'error'}
      class="toast"
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      onpointerenter={() => queue.pause(toast.id, 'hover')}
      onpointerleave={() => queue.resume(toast.id, 'hover')}
      onfocusin={() => queue.pause(toast.id, 'focus')}
      onfocusout={() => queue.resume(toast.id, 'focus')}
    >
      <span class="toast-symbol" aria-hidden="true">
        {toast.kind === 'error' ? '!' : toast.kind === 'success' ? '✓' : 'i'}
      </span>
      <span class="toast-copy">
        <strong
          >{toast.kind === 'error'
            ? 'Error'
            : toast.kind === 'success'
              ? 'Success'
              : 'Info'}</strong
        >
        <span>{toast.message}</span>
        {#if toast.occurrences > 1}<small>Repeated {toast.occurrences} times.</small>{/if}
      </span>
      <button
        type="button"
        aria-label={`Dismiss ${toast.kind} notification`}
        onclick={() => queue.dismiss(toast.id)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </section>
  {/each}
</div>

<style>
  .toast-viewport {
    position: fixed;
    inset-block-start: calc(1rem + env(safe-area-inset-top));
    inset-inline-end: max(0.75rem, env(safe-area-inset-right));
    z-index: 10;
    display: grid;
    gap: 0.5rem;
    inline-size: min(24rem, calc(100vw - 1.5rem));
    max-block-size: calc(100dvh - 7rem);
    overflow-y: auto;
    pointer-events: none;
  }

  .toast {
    box-sizing: border-box;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 44px;
    align-items: start;
    gap: 0.6rem;
    min-inline-size: 0;
    padding: 0.65rem;
    color: CanvasText;
    background: Canvas;
    border: 1px solid CanvasText;
    border-inline-start-width: 0.35rem;
    border-radius: 0.55rem;
    box-shadow: 0 0.4rem 1.2rem color-mix(in srgb, CanvasText 24%, transparent);
    pointer-events: auto;
  }

  .toast.error {
    border-inline-start-style: double;
  }

  .toast-symbol {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    inline-size: 1.6rem;
    block-size: 1.6rem;
    border: 2px solid currentColor;
    border-radius: 50%;
    font-weight: 800;
    line-height: 1;
  }

  .toast-copy {
    display: grid;
    gap: 0.15rem;
    min-inline-size: 0;
    padding-block: 0.1rem;
    overflow-wrap: anywhere;
  }

  .toast-copy strong {
    text-transform: capitalize;
  }

  .toast-copy small {
    opacity: 0.72;
  }

  button {
    display: grid;
    place-items: center;
    inline-size: 44px;
    min-block-size: 44px;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: 0.35rem;
    font: inherit;
    font-size: 1.5rem;
  }

  button:hover {
    background: color-mix(in srgb, CanvasText 10%, transparent);
  }

  @media (max-width: 24rem) {
    .toast {
      gap: 0.25rem;
      padding: 0.35rem;
    }

    .toast-symbol {
      inline-size: 1.25rem;
      block-size: 1.25rem;
      font-size: 0.75rem;
    }

    .toast-copy strong {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
  }

  @media (forced-colors: active) {
    .toast,
    .toast-symbol {
      border-color: CanvasText;
    }
  }
</style>
