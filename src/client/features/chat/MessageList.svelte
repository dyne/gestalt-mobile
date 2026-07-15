<script lang="ts">
  import type { ChatMessage } from './message-store.js';
  import { groupMessages } from './message-groups.js';
  import { renderCommentary, type CommentaryPart } from './rendering.js';

  let { messages }: { messages: ChatMessage[] } = $props();
  let groups = $derived(groupMessages(messages));
</script>

{#snippet inline(parts: CommentaryPart[])}
  {#each parts as part, partIndex (partIndex)}
    {#if part.kind === 'link'}
      <a href={part.href} target="_blank" rel="noreferrer">{part.text}</a>
    {:else if part.kind === 'code'}
      <code>{part.text}</code>
    {:else}
      {part.text}
    {/if}
  {/each}
{/snippet}

{#snippet content(text: string)}
  {#each renderCommentary(text) as block, blockIndex (blockIndex)}
    {#if block.kind === 'code'}
      <pre><code>{block.text}</code></pre>
    {:else if block.kind === 'table'}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              {#each block.headers as header, headerIndex (headerIndex)}
                <th scope="col">{@render inline(header)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each block.rows as row, rowIndex (rowIndex)}
              <tr>
                {#each row as cell, cellIndex (cellIndex)}
                  <td>{@render inline(cell)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div>{@render inline(block.parts)}</div>
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

  .table-scroll {
    overflow-x: auto;
    margin-block: 0.75rem;
  }

  table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    white-space: normal;
  }

  th,
  td {
    padding: 0.25rem 0.5rem;
    text-align: left;
    vertical-align: top;
  }

  th {
    font-weight: 600;
  }
</style>
