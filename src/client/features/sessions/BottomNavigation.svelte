<script lang="ts">
  import { nextTab, type Tab } from './tab-state.js';

  type Props = {
    activeTab: Tab;
    onselect: (tab: Tab) => void;
  };

  let { activeTab, onselect }: Props = $props();
  const buttons: Partial<Record<Tab, HTMLButtonElement>> = {};

  function handleKeydown(event: KeyboardEvent): void {
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : null;
    if (direction === null) return;
    event.preventDefault();
    const next = nextTab(activeTab, direction);
    onselect(next);
    buttons[next]?.focus();
  }
</script>

<nav aria-label="Primary">
  <button bind:this={buttons.chat} aria-pressed={activeTab === 'chat'} onkeydown={handleKeydown} onclick={() => onselect('chat')}>Chat</button>
  <button bind:this={buttons.git} aria-pressed={activeTab === 'git'} onkeydown={handleKeydown} onclick={() => onselect('git')}>Git</button>
  <button bind:this={buttons.sessions} aria-pressed={activeTab === 'sessions'} onkeydown={handleKeydown} onclick={() => onselect('sessions')}>Sessions</button>
</nav>
