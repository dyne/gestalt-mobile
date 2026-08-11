<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import {
    argumentPickerFor,
    commandQuery,
    matchingCommands,
    sortModelsNewestFirst,
  } from './command-completion.js';
  import { submitsOnEnter } from './keyboard.js';
  type Props = {
    status: string;
    message: string;
    activeTurnId: string | null;
    starting: boolean;
    models?: string[];
    onchange(value: string): void;
    onscrollbottom?(): void;
    onmodelselect?(model: string): void;
    onsend(): void;
    oninterrupt(): void;
  };
  let {
    status,
    message,
    activeTurnId,
    starting,
    models = [],
    onchange,
    onscrollbottom = () => {},
    onmodelselect = () => {},
    onsend,
    oninterrupt,
  }: Props = $props();

  let selectedCommandIndex = $state(0);
  let dismissedCommandQuery = $state<string | null>(null);
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

  function updateMessage(value: string, requestTail = false): void {
    dismissedCommandQuery = null;
    selectedCommandIndex = 0;
    onchange(value);
    if (requestTail) onscrollbottom();
  }

  function chooseCommand(index = selectedCommandIndex): void {
    const command = commandMatches[index];
    if (!command) return;
    updateMessage(`/${command.name} `, true);
  }

  function keydown(event: KeyboardEvent): void {
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
      if (event.key === 'Tab' || submitsOnEnter(event)) {
        event.preventDefault();
        chooseCommand();
        return;
      }
    }
    if (!submitsOnEnter(event) || activeTurnId || starting || !message.trim()) return;
    event.preventDefault();
    onsend();
  }
</script>

<form
  onsubmit={(event) => {
    event.preventDefault();
    onsend();
  }}
>
  <p role="status" aria-label={status}>
    {#if status === 'Ready.'}
      Ready <span class="block-cursor" aria-hidden="true"></span>
    {:else}
      {status}
    {/if}
  </p>
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
              onscrollbottom();
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
      id="message"
      aria-label="Prompt"
      placeholder="Prompt"
      value={message}
      oninput={(event) => updateMessage(event.currentTarget.value)}
      onkeydown={keydown}
      rows="1"
      required></textarea>
    <button
      type="submit"
      aria-label="Send prompt"
      disabled={Boolean(activeTurnId) || starting || !message.trim()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M9 10 5 14l4 4M5 14h8a6 6 0 0 0 6-6V6" />
      </svg>
    </button>
  </div>
  {#if activeTurnId}<button type="button" onclick={oninterrupt}>Interrupt</button>{/if}
</form>

<style>
  form > [role='status'] {
    margin-block: 1rem 0.35rem;
    text-align: start;
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
  .prompt-row button {
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
