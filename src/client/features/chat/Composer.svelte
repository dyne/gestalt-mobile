<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { MAX_UPLOAD_BYTES } from '../../../shared/contracts/file-upload.js';
  import {
    argumentPickerFor,
    commandQuery,
    matchingCommands,
    sortModelsNewestFirst,
  } from './command-completion.js';
  import type { LlmProvider } from '../../../shared/contracts/llm-provider.js';
  type Props = {
    status: string;
    readySince?: number | null;
    message: string;
    activeTurnId: string | null;
    starting: boolean;
    newEmpty?: boolean;
    detached?: boolean;
    retryMessage?: string | null;
    retryable?: boolean;
    models?: string[];
    /** Owning provider; used only for provider-aware copy. */
    provider?: LlmProvider;
    onchange(value: string): void;
    onrevealprompt?(): void;
    onmodelselect?(model: string): void;
    onsend(): void;
    onqueue?(): void;
    oninterruptsend?(): void;
    onretry?(): void;
    oninterrupt(): void;
    onuploadfiles?(files: File[]): Promise<void>;
  };
  let {
    status,
    readySince = null,
    message,
    activeTurnId,
    starting,
    newEmpty = false,
    detached = false,
    retryMessage = null,
    retryable = false,
    models = [],
    provider = 'codex',
    onchange,
    onrevealprompt = () => {},
    onmodelselect = () => {},
    onsend,
    onqueue = () => {},
    oninterruptsend = () => {},
    onretry = () => {},
    oninterrupt,
    onuploadfiles,
  }: Props = $props();

  let now = $state(Date.now());
  let uploading = $state(false);
  let dragDepth = $state(0);
  let uploadInput = $state<HTMLInputElement | null>(null);

  function pickFiles(): void {
    if (uploading || !onuploadfiles) return;
    actionMenuOpen = false;
    uploadInput?.click();
  }

  function filesChosen(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    void uploadFiles(files);
  }

  async function uploadFiles(files: File[]): Promise<void> {
    if (uploading || !onuploadfiles || files.length === 0) return;
    uploading = true;
    try {
      await onuploadfiles(files);
    } finally {
      uploading = false;
    }
  }

  function fileDrag(event: DragEvent): boolean {
    return Boolean(onuploadfiles && event.dataTransfer?.types.includes('Files'));
  }

  function dragEnter(event: DragEvent): void {
    if (!fileDrag(event)) return;
    event.preventDefault();
    if (!uploading) dragDepth += 1;
  }

  function dragOver(event: DragEvent): void {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = uploading ? 'none' : 'copy';
  }

  function dragLeave(event: DragEvent): void {
    if (fileDrag(event)) dragDepth = Math.max(0, dragDepth - 1);
  }

  async function dropFiles(event: DragEvent): Promise<void> {
    if (!fileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    await uploadFiles(Array.from(event.dataTransfer!.files));
  }
  let readyLabel = $derived.by(() => {
    if (readySince == null) return 'Ready';
    const minutes = Math.floor(Math.max(0, now - readySince) / 60_000);
    if (minutes === 0) return 'Ready since less than a minute ago';
    const days = Math.floor(minutes / 1_440);
    const hours = Math.floor((minutes % 1_440) / 60);
    const remainder = minutes % 60;
    const parts: string[] = [];
    if (days) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
    if (hours) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
    if (remainder) parts.push(`${remainder} ${remainder === 1 ? 'minute' : 'minutes'}`);
    return `Ready since ${parts.join(' ')} ago`;
  });
  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  let selectedCommandIndex = $state(0);
  let dismissedCommandQuery = $state<string | null>(null);
  let actionMenuOpen = $state(false);
  let commandMatches = $derived(matchingCommands(message));
  let currentCommandQuery = $derived(commandQuery(message));
  let commandMenuOpen = $derived(
    currentCommandQuery !== null &&
      currentCommandQuery !== dismissedCommandQuery &&
      commandMatches.length > 0,
  );
  let argumentPicker = $derived(argumentPickerFor(message));
  let modelMenuOpen = $derived(argumentPicker === 'models');
  let sortedModels = $derived(sortModelsNewestFirst(models));
  let reasoningMenuOpen = $derived(argumentPicker === 'reasoning');
  let sendEnabled = $derived(!activeTurnId && !starting && !uploading && Boolean(message.trim()));
  let hasPrompt = $derived(Boolean(message.trim()));
  let retryFromPrompt = $derived(retryable && !retryMessage);

  function chooseActiveAction(action: 'queue' | 'interrupt-send' | 'interrupt'): void {
    if (starting || uploading) return;
    actionMenuOpen = false;
    if (action === 'queue') onqueue();
    else if (action === 'interrupt') oninterrupt();
    else oninterruptsend();
  }

  function updateMessage(value: string, revealPrompt = false): void {
    dismissedCommandQuery = null;
    selectedCommandIndex = 0;
    onchange(value);
    if (revealPrompt) onrevealprompt();
  }

  function chooseCommand(index = selectedCommandIndex): void {
    const command = commandMatches[index];
    if (!command) return;
    updateMessage(`/${command.name} `, true);
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) {
      if (activeTurnId && !starting && hasPrompt) {
        event.preventDefault();
        chooseActiveAction('queue');
        return;
      }
      if (sendEnabled) {
        event.preventDefault();
        onsend();
        return;
      }
    }
    if (commandMenuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        selectedCommandIndex = (selectedCommandIndex + 1) % commandMatches.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        selectedCommandIndex =
          (selectedCommandIndex - 1 + commandMatches.length) % commandMatches.length;
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissedCommandQuery = currentCommandQuery;
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        chooseCommand();
        return;
      }
    }
  }
</script>

<form
  aria-busy={starting || uploading}
  class:drag-over={dragDepth > 0}
  ondragenter={dragEnter}
  ondragover={dragOver}
  ondragleave={dragLeave}
  ondrop={dropFiles}
>
  <p
    role="status"
    aria-live="polite"
    aria-atomic="true"
    aria-label={status === 'Ready.' && readySince != null ? readyLabel : status}
  >
    {#if status === 'Ready.'}
      {readyLabel} <span class="block-cursor" aria-hidden="true"></span>
    {:else}
      {status}
    {/if}
  </p>
  {#if onuploadfiles}
    <input
      bind:this={uploadInput}
      type="file"
      multiple
      hidden
      aria-label="Choose files to upload"
      disabled={uploading}
      onchange={filesChosen}
    />
    <p class="upload-hint" aria-live="polite" aria-atomic="true">
      {#if uploading}
        Uploading files to workspace root…
      {:else if dragDepth > 0}
        Drop files to upload to workspace root · {MAX_UPLOAD_BYTES / 1024 / 1024} MiB per file
      {:else}
        Upload or drop files · {MAX_UPLOAD_BYTES / 1024 / 1024} MiB per file
      {/if}
    </p>
  {/if}
  {#if detached}
    <p id="writer-hint" class="writer-hint">
      You can read this conversation. Sending will connect to {provider === 'kimi'
        ? 'Kimi'
        : 'Codex'}.
    </p>
  {/if}
  {#if retryMessage}
    <div class="writer-feedback" role="alert" aria-atomic="true">
      <p>{retryMessage}</p>
      {#if retryable}
        <button type="button" disabled={starting || uploading} onclick={onretry}>Retry send</button>
      {/if}
    </div>
  {/if}
  {#if commandMenuOpen}
    <ul id="chat-command-completion" class="command-menu" aria-label="Chat commands">
      {#each commandMatches as command, index (command.name)}
        <li class={index === selectedCommandIndex ? 'command-selected' : undefined}>
          <button type="button" onclick={() => chooseCommand(index)}>
            <code>/{command.name}</code>
            <small>{command.description}</small>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if modelMenuOpen}
    <ul class="command-menu" aria-label="Available models">
      {#each sortedModels as model (model)}
        <li>
          <button
            type="button"
            onclick={() => {
              onmodelselect(model);
              onrevealprompt();
            }}><code>{model}</code></button
          >
        </li>
      {/each}
    </ul>
  {/if}
  {#if reasoningMenuOpen}
    <ul class="command-menu" aria-label="Reasoning efforts">
      {#each ['low', 'medium', 'high'] as effort (effort)}
        <li>
          <button type="button" onclick={() => updateMessage(`/reasoning ${effort} `, true)}
            ><code>{effort}</code></button
          >
        </li>
      {/each}
    </ul>
  {/if}
  <div class="prompt-row">
    <textarea
      class:new-empty={newEmpty}
      id="message"
      aria-label="Prompt"
      placeholder="Prompt"
      value={message}
      aria-describedby={detached ? 'writer-hint' : undefined}
      oninput={(event) => updateMessage(event.currentTarget.value)}
      onkeydown={keydown}
      rows="1"
      required></textarea>
    {#if activeTurnId}
      <div class="prompt-action">
        <button
          type="button"
          aria-label="Choose prompt action"
          disabled={starting || uploading}
          aria-expanded={actionMenuOpen}
          aria-controls="prompt-action-panel"
          onclick={() => (actionMenuOpen = !actionMenuOpen)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="6" cy="12" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="18" cy="12" r="1.5" />
          </svg>
        </button>
        {#if actionMenuOpen}
          <div id="prompt-action-panel" class="action-panel" aria-label="Prompt actions">
            {#if onuploadfiles}
              <button type="button" disabled={uploading} onclick={pickFiles}>Upload files</button>
            {/if}
            {#if hasPrompt}
              <button
                type="button"
                disabled={starting || uploading}
                onclick={() => chooseActiveAction('queue')}>Queue message</button
              >
              <button
                type="button"
                disabled={starting || uploading}
                onclick={() => chooseActiveAction('interrupt-send')}>Interrupt and send</button
              >
            {:else}
              <button
                type="button"
                disabled={starting || uploading}
                onclick={() => chooseActiveAction('interrupt')}>Interrupt</button
              >
            {/if}
          </div>
        {/if}
      </div>
    {:else if !hasPrompt && onuploadfiles}
      <button
        type="button"
        aria-label="Upload files"
        title="Upload files"
        disabled={uploading}
        onclick={pickFiles}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4" />
        </svg>
      </button>
    {:else}
      <button
        type="button"
        aria-label={retryFromPrompt ? 'Retry send' : 'Send prompt'}
        disabled={!sendEnabled}
        onclick={retryFromPrompt ? onretry : onsend}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M9 10 5 14l4 4M5 14h8a6 6 0 0 0 6-6V6" />
        </svg>
      </button>
    {/if}
  </div>
</form>

<style>
  form.drag-over {
    outline: 2px dashed var(--theme-focus);
    outline-offset: -2px;
  }
  .upload-hint {
    margin-block: 0.35rem;
    color: var(--theme-text-muted);
    font-size: 0.85em;
  }
  form > [role='status'] {
    margin-block: 1rem 0.35rem;
    text-align: start;
  }
  .writer-hint {
    margin: 0.35rem 0;
    color: var(--theme-text-muted);
  }
  .writer-feedback {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin-block: 0.5rem;
    padding: 0.5rem;
    border-inline-start: 0.25rem solid var(--theme-danger, #b42318);
    background: var(--theme-control-hover);
  }
  .writer-feedback p {
    flex: 1 1 16rem;
    margin: 0;
  }
  .command-menu {
    display: grid;
    gap: 0.125rem;
    max-inline-size: min(100%, 32rem);
    margin: 0 0 0.35rem;
    padding: 0.25rem;
    list-style: none;
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 0.375rem;
  }
  .command-menu button {
    display: flex;
    inline-size: 100%;
    gap: 0.5rem;
    align-items: baseline;
    padding: 0.25rem 0.375rem;
    color: var(--theme-text);
    text-align: start;
    background: transparent;
    border: 0;
    border-radius: 0.25rem;
  }
  .command-menu .command-selected button,
  .command-menu button:hover {
    background: var(--theme-control-hover);
  }
  .command-menu small {
    color: var(--theme-text-muted);
    font-size: 0.8em;
  }
  .command-menu button:focus-visible {
    outline: 2px solid var(--theme-focus);
    outline-offset: 1px;
  }
  .prompt-row {
    display: flex;
    align-items: end;
    gap: 0.5rem;
  }
  textarea {
    flex: 1 1 auto;
    min-block-size: 2.75rem;
    resize: vertical;
  }
  textarea.new-empty {
    block-size: min(75dvh, max(2.75rem, calc(100dvh - 16rem)));
  }
  .prompt-row > button,
  .prompt-action > button {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    inline-size: 3rem;
    min-block-size: 3rem;
    padding: 0;
  }
  .prompt-row svg {
    inline-size: 1.35rem;
    block-size: 1.35rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .prompt-action {
    position: relative;
    flex: 0 0 auto;
  }
  .prompt-action > button {
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .prompt-action > button:hover {
    background: var(--theme-control-hover);
  }
  .prompt-action > button:focus-visible {
    outline: 2px solid var(--theme-focus);
    outline-offset: 2px;
  }
  .action-panel {
    position: absolute;
    z-index: 2;
    display: grid;
    gap: 0.125rem;
    min-inline-size: max-content;
    inset-block-start: calc(100% + 0.35rem);
    inset-inline-end: 0;
    padding: 0.25rem;
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 0.375rem;
    box-shadow: 0 0.35rem 1rem rgb(0 0 0 / 18%);
  }
  .action-panel button {
    inline-size: 100%;
    padding: 0.5rem 0.65rem;
    color: var(--theme-text);
    text-align: start;
    white-space: nowrap;
    background: transparent;
    border: 0;
    border-radius: 0.25rem;
  }
  .action-panel button:hover {
    background: var(--theme-control-hover);
  }
  .block-cursor {
    display: inline-block;
    inline-size: 0.55ch;
    block-size: 1em;
    vertical-align: -0.1em;
    background: var(--theme-accent);
    animation: blink 1s steps(2, start) infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .block-cursor {
      animation: none;
    }
  }
  @keyframes blink {
    50% {
      opacity: 0;
    }
  }
</style>
