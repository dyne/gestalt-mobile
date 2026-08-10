<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    browserScratchpadStorage,
    clearScratchpad,
    readScratchpad,
    type ScratchpadStorage,
    writeScratchpad,
  } from './scratchpad-storage.js';

  type ClipboardReader = Pick<Clipboard, 'readText'>;

  let {
    onclose,
    storage = browserScratchpadStorage(),
    clipboard = globalThis.navigator?.clipboard,
  }: {
    onclose: () => void;
    storage?: ScratchpadStorage | null;
    clipboard?: ClipboardReader;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let cancelClearButton = $state<HTMLButtonElement | null>(null);
  let text = $state('');
  let confirmingClear = $state(false);
  let feedback = $state('');

  onMount(async () => {
    text = readScratchpad(storage);
    await tick();
    dialog?.showModal();
    textarea?.focus();
  });

  function persist(value: string): void {
    text = value;
    feedback = writeScratchpad(storage, value)
      ? ''
      : 'This browser could not save the scratchpad. Keep this window open until you copy the text.';
  }

  async function pasteFromClipboard(): Promise<void> {
    if (!clipboard?.readText) {
      feedback = 'Clipboard paste is unavailable here. Long-press the text field and choose Paste.';
      textarea?.focus();
      return;
    }
    try {
      const pasted = await clipboard.readText();
      const start = textarea?.selectionStart ?? text.length;
      const end = textarea?.selectionEnd ?? text.length;
      persist(`${text.slice(0, start)}${pasted}${text.slice(end)}`);
      await tick();
      const caret = start + pasted.length;
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    } catch {
      feedback = 'Clipboard paste was not permitted. Long-press the text field and choose Paste.';
      textarea?.focus();
    }
  }

  async function requestClear(): Promise<void> {
    confirmingClear = true;
    feedback = '';
    await tick();
    cancelClearButton?.focus();
  }

  function cancelClear(): void {
    confirmingClear = false;
    textarea?.focus();
  }

  function clearAll(): void {
    if (!clearScratchpad(storage)) {
      feedback = 'This browser could not clear its saved scratchpad.';
      return;
    }
    text = '';
    confirmingClear = false;
    feedback = '';
    textarea?.focus();
  }
</script>

<dialog bind:this={dialog} aria-labelledby="scratchpad-title" {onclose}>
  <section class="scratchpad-shell">
    <header>
      <div>
        <h2 id="scratchpad-title">Scratchpad</h2>
        <p id="scratchpad-help">Saved automatically in this browser.</p>
      </div>
      <button
        type="button"
        class="close"
        aria-label="Close scratchpad"
        onclick={() => dialog?.close()}>×</button
      >
    </header>

    <label for="scratchpad-text">Scratchpad text</label>
    <textarea
      bind:this={textarea}
      id="scratchpad-text"
      aria-describedby="scratchpad-help"
      value={text}
      oninput={(event) => persist(event.currentTarget.value)}></textarea>

    {#if feedback}<p class="feedback" role="status">{feedback}</p>{/if}

    {#if confirmingClear}
      <section class="clear-confirmation" aria-labelledby="clear-scratchpad-title">
        <p id="clear-scratchpad-title"><strong>Clear the entire scratchpad?</strong></p>
        <p>This cannot be undone.</p>
        <div class="actions">
          <button bind:this={cancelClearButton} type="button" onclick={cancelClear}
            >Keep text</button
          >
          <button type="button" class="danger" onclick={clearAll}>Clear all</button>
        </div>
      </section>
    {:else}
      <footer class="actions">
        <button type="button" onclick={() => void pasteFromClipboard()}>Paste</button>
        <button type="button" onclick={() => textarea?.select()}>Select all</button>
        <button type="button" class="danger" disabled={!text} onclick={() => void requestClear()}
          >Clear</button
        >
        <button type="button" onclick={() => dialog?.close()}>Close</button>
      </footer>
    {/if}
  </section>
</dialog>

<style>
  dialog {
    box-sizing: border-box;
    inline-size: min(52rem, calc(100vw - 1rem));
    max-inline-size: none;
    max-block-size: calc(100dvh - 1rem);
    padding: 0;
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
    box-shadow: 0 0.75rem 2rem var(--theme-shadow);
  }
  dialog::backdrop {
    background: color-mix(in srgb, var(--theme-canvas) 70%, transparent);
  }
  .scratchpad-shell {
    display: grid;
    grid-template-rows: auto auto minmax(12rem, 1fr) auto;
    gap: 0.75rem;
    box-sizing: border-box;
    min-block-size: min(42rem, calc(100dvh - 1rem));
    max-block-size: calc(100dvh - 1rem);
    padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
      max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }
  h2,
  p {
    margin: 0;
  }
  h2 {
    font-family: var(--theme-font-display);
  }
  header p {
    color: var(--theme-text-muted);
  }
  label {
    font-weight: 700;
  }
  textarea {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    min-block-size: 12rem;
    padding: 0.75rem;
    resize: none;
    color: var(--theme-text);
    background: var(--theme-canvas);
    border: 1px solid var(--theme-border);
    border-radius: calc(var(--theme-radius) / 2);
    font: 1rem/1.45 var(--theme-font-code);
    tab-size: 2;
  }
  button {
    min-block-size: 44px;
    font: inherit;
  }
  .close {
    flex: 0 0 auto;
    inline-size: 44px;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
    font-size: 2rem;
    line-height: 1;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .actions button {
    flex: 1 1 7rem;
  }
  .danger {
    color: var(--theme-error);
  }
  .clear-confirmation {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem;
    border: 1px solid var(--theme-error);
    border-radius: calc(var(--theme-radius) / 2);
  }
  .feedback {
    color: var(--theme-error);
    font-weight: 700;
  }
  @media (max-width: 32rem) {
    dialog {
      inline-size: 100vw;
      max-block-size: 100dvh;
      border-inline: 0;
      border-radius: 0;
    }
    .scratchpad-shell {
      min-block-size: 100dvh;
      max-block-size: 100dvh;
    }
  }
  @media (forced-colors: active) {
    dialog,
    textarea,
    .clear-confirmation {
      border-color: CanvasText;
    }
  }
</style>
