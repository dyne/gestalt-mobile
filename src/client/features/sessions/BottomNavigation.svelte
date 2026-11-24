<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import Icon from '../../components/Icon.svelte';
  import { nextTab, type Tab } from './tab-state.js';

  const destinations = [
    { tab: 'sessions', label: 'Sessions' },
    { tab: 'git', label: 'Git' },
    { tab: 'chat', label: 'Chat' },
    { tab: 'plan', label: 'Plan' },
  ] as const;

  type Props = {
    activeTab: Tab;
    chatEnabled: boolean;
    focusTab?: Tab | null;
    onselect: (tab: Tab) => void;
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
  {#each destinations as { tab, label } (tab)}
    <button
      bind:this={buttons[tab]}
      aria-pressed={activeTab === tab}
      disabled={tab === 'chat' && !chatEnabled}
      onkeydown={handleKeydown}
      onclick={() => onselect(tab)}
    >
      <Icon name={tab} size="18px" />
      {label}
    </button>
  {/each}
</nav>
