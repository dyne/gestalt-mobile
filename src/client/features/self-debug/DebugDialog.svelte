<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import type { DebugConfirmation } from '../../../shared/contracts/self-debug.js';
  import DebugIdentifiers from './DebugIdentifiers.svelte';
  let {
    confirmation,
    onconfirm,
    onclose,
  }: { confirmation: DebugConfirmation; onconfirm(): Promise<void>; onclose(): void } = $props();
  let dialog: HTMLDialogElement;
  let cancel: HTMLButtonElement;
  let pending = $state(false);
  onMount(() => {
    dialog.showModal();
    cancel.focus();
  });
  async function confirm() {
    if (pending) return;
    pending = true;
    try {
      await onconfirm();
    } catch {
      /* The relay reports failures through shared notifications. */
    } finally {
      pending = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="debug-title"
  aria-describedby="debug-description"
  aria-busy={pending}
  oncancel={(event) => {
    if (pending) event.preventDefault();
  }}
  {onclose}
>
  <h2 id="debug-title">Confirm spawning a new Gestalt DEBUG session?</h2>
  <p id="debug-description">
    Capture a redacted diagnostic trace and start an independent agent in ~/.gestalt/self-debug to
    investigate and fix the error.
  </p>
  <DebugIdentifiers context={confirmation.context} />
  <div class="dialog-actions">
    <button bind:this={cancel} type="button" disabled={pending} onclick={() => dialog.close()}
      >Cancel</button
    >
    <button type="button" disabled={pending} onclick={() => void confirm()}
      >{pending ? 'Preparing Self DEBUG…' : 'Start Self DEBUG'}</button
    >
  </div>
</dialog>

<style>
  dialog {
    box-sizing: border-box;
    inline-size: min(36rem, calc(100vw - 2rem));
    max-block-size: calc(100dvh - 2rem);
    overflow: auto;
    padding: 1.25rem;
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }
  dialog::backdrop {
    background: color-mix(in srgb, var(--theme-page) 58%, transparent);
  }
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1.25rem;
  }
  p {
    margin: 0;
    color: var(--theme-text-muted);
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-block-start: 1.5rem;
  }
  button {
    min-block-size: 2.75rem;
  }
  button:last-child {
    font-weight: 700;
  }
</style>
