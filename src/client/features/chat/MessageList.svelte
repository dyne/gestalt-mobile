<script lang="ts">
  import type { ChatMessage } from './message-store.js';
  import { groupMessages } from './message-groups.js';
  import { renderCommentary } from './rendering.js';

  let { messages }: { messages: ChatMessage[] } = $props();
  let groups = $derived(groupMessages(messages));
</script>

{#snippet content(text: string)}
  {#each renderCommentary(text) as block, blockIndex (blockIndex)}
    {#if block.kind === 'code'}
      <pre><code>{block.text}</code></pre>
    {:else}
      <div>{#each block.parts as part, partIndex (partIndex)}{#if part.kind === 'link'}<a href={part.href} target="_blank" rel="noreferrer">{part.text}</a>{:else if part.kind === 'code'}<code>{part.text}</code>{:else}{part.text}{/if}{/each}</div>
    {/if}
  {/each}
{/snippet}

<ol aria-label="Chat messages">
  {#each groups as group (group.id)}
    <li>
      {#if group.kind === 'user'}
        <strong>user:</strong> {group.text}
      {:else if group.answer}
        <section class="answer-turn">
          <strong>answer</strong>
          {@render content(group.answer)}
          {#if group.commentary}
            <details>
              <summary>commentary</summary>
              {@render content(group.commentary)}
            </details>
          {/if}
        </section>
      {:else if group.commentary}
        <details>
          <summary>commentary</summary>
          {@render content(group.commentary)}
        </details>
      {/if}
    </li>
  {/each}
</ol>

<style>
  li {
    white-space: pre-wrap;
  }

  pre,
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  pre {
    white-space: pre;
    overflow-x: auto;
  }
</style>
