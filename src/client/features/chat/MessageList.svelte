<script lang="ts">
  import type { ChatMessage } from './message-store.js';
  import { renderCommentary } from './rendering.js';

  let { messages }: { messages: ChatMessage[] } = $props();
</script>

<ol aria-label="Chat messages">
  {#each messages as message (message.id)}
    <li>
      {#if message.role === 'user'}
        <strong>user:</strong> {message.text}
      {:else if message.phase === 'commentary'}
        <details>
          <summary>commentary</summary>
          {#each renderCommentary(message.text) as block, blockIndex (blockIndex)}
            {#if block.kind === 'code'}
              <pre><code>{block.text}</code></pre>
            {:else}
              <div>{#each block.parts as part, partIndex (partIndex)}{#if part.kind === 'link'}<a href={part.href} target="_blank" rel="noreferrer">{part.text}</a>{:else}{part.text}{/if}{/each}</div>
            {/if}
          {/each}
        </details>
      {:else}
        <strong>answer</strong>
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
