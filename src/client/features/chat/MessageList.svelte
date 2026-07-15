<script lang="ts">
  import type { ChatMessage } from './message-store.js';

  let { messages }: { messages: ChatMessage[] } = $props();
</script>

<ol aria-label="Chat messages">
  {#each messages as message (message.id)}
    <li><strong>{message.role}:</strong> {message.text}</li>
  {/each}
</ol>

<style>
  li {
    white-space: pre-wrap;
  }
</style>
