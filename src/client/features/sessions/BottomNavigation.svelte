<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { nextTab, type Tab } from './tab-state.js';

  type Props = {
    activeTab: Tab;
    chatEnabled: boolean;
    focusTab?: Tab | null;
    onselect: (tab: Tab, focusChatPrompt?: boolean) => void;
  };

  let { activeTab, chatEnabled, focusTab = null, onselect }: Props = $props();
  let buttons = $state<Partial<Record<Tab, HTMLButtonElement>>>({});

  $effect(() => {
    if (focusTab) buttons[focusTab]?.focus();
  });

  function handleKeydown(event: KeyboardEvent): void {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : null;
    if (direction === null) return;
    event.preventDefault();
    const next = nextTab(activeTab, direction, { chatEnabled });
    onselect(next);
    buttons[next]?.focus();
  }
</script>

<nav class="bottom-navigation" aria-label="Primary">
  <button
    bind:this={buttons.sessions}
    aria-pressed={activeTab === 'sessions'}
    onkeydown={handleKeydown}
    onclick={() => onselect('sessions')}>Sess<wbr />ions</button
  >
  <button
    bind:this={buttons.git}
    aria-pressed={activeTab === 'git'}
    onkeydown={handleKeydown}
    onclick={() => onselect('git')}>Git</button
  >
  <button
    bind:this={buttons.chat}
    aria-pressed={activeTab === 'chat'}
    disabled={!chatEnabled}
    onkeydown={handleKeydown}
    onclick={() => onselect('chat', true)}>Chat</button
  >
  <button
    bind:this={buttons.plan}
    aria-pressed={activeTab === 'plan'}
    onkeydown={handleKeydown}
    onclick={() => onselect('plan')}>Plan</button
  >
</nav>
