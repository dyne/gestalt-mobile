<script lang="ts">
  import type { ChatMessage } from './message-store.js';

  let { messages }: { messages: ChatMessage[] } = $props();
</script>

<ol aria-label="Chat messages">
  {#each messages as message (message.id)}
    <li>
      {#if message.role === 'user'}
        <strong>user:</strong> {message.text}
      {:else if message.phase === 'commentary'}
        <details>
          <summary>Codex commentary</summary>
          <div>{message.text}</div>
        </details>
      {:else}
        <strong>Codex answer</strong>
        <div>{message.text}</div>
      {/if}
    </li>
  {/each}
</ol>

<style>
  li {
    white-space: pre-wrap;
  }
</style>
