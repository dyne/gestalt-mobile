<script lang="ts">
  let tab = $state<'chat' | 'git' | 'sessions'>('chat');
</script>

<svelte:head>
  <title>Codex Relay</title>
</svelte:head>

<main>
  <header>
    <h1>Codex Relay</h1>
    <p role="status">Connecting to the relay…</p>
  </header>

  {#if tab === 'chat'}
    <section aria-labelledby="chat-title"><h2 id="chat-title">Chat</h2><p>Start a session to chat with Codex.</p></section>
  {:else if tab === 'git'}
    <section aria-labelledby="git-title"><h2 id="git-title">Git</h2><p>Select a session to view its workspace status.</p></section>
  {:else}
    <section aria-labelledby="sessions-title"><h2 id="sessions-title">Sessions</h2><p>No sessions are loaded yet.</p></section>
  {/if}

  <nav aria-label="Primary">
    <button aria-pressed={tab === 'chat'} onclick={() => (tab = 'chat')}>Chat</button>
    <button aria-pressed={tab === 'git'} onclick={() => (tab = 'git')}>Git</button>
    <button aria-pressed={tab === 'sessions'} onclick={() => (tab = 'sessions')}>Sessions</button>
  </nav>
</main>
