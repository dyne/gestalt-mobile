<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { nextTab, type Tab } from './tab-state.js';

  const destinations = [
    { tab: 'sessions', label: 'Sessions', path: 'M3 7h7l2 2h9v10H3z M5 4h6l2 2h6' },
    {
      tab: 'git',
      label: 'Git',
      path: 'M8 8v8 M10 15c5 0 7-2 7-5 M8 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M8 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M17 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    },
    {
      tab: 'chat',
      label: 'Chat',
      path: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2z M7 9h10 M7 13h6',
    },
    { tab: 'plan', label: 'Plan', path: 'm3 7 2 2 3-4 M12 7h9 M3 15l2 2 3-4 M12 15h9' },
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
  {#each destinations as { tab, label, path } (tab)}
    <button
      bind:this={buttons[tab]}
      aria-pressed={activeTab === tab}
      disabled={tab === 'chat' && !chatEnabled}
      onkeydown={handleKeydown}
      onclick={() => onselect(tab)}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d={path} /></svg>
      {label}
    </button>
  {/each}
</nav>
