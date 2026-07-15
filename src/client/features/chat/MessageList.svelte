<script lang="ts">
  import type { ChatMessage } from './message-store.js';
  import { groupMessages } from './message-groups.js';
  import { formatElapsedAfter, formatMessageTime } from './message-time.js';
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
  {#each groups as group, index (group.id)}
    <li>
      {#if group.kind === 'user'}
        <div class="entry-heading">
          <strong>prompt</strong>
          {#if group.occurredAt}
            <time datetime={new Date(group.occurredAt).toISOString()}>
              {formatMessageTime(group.occurredAt)}
              {#if formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
                · {formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
              {/if}
            </time>
          {/if}
        </div>
        <div class="entry-content">{@render content(group.text)}</div>
      {:else if group.answer}
        <section class="answer-turn">
          <div class="entry-heading">
            <strong>answer</strong>
            {#if group.occurredAt}
              <time datetime={new Date(group.occurredAt).toISOString()}>
                {formatMessageTime(group.occurredAt)}
                {#if formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
                  · {formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
                {/if}
              </time>
            {/if}
          </div>
          <div class="entry-content">{@render content(group.answer)}</div>
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
    margin-block-end: 0;
    white-space: pre-wrap;
  }

  li + li {
    margin-block-start: 1.5rem;
  }

  .entry-heading {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
  }

  time {
    color: #666;
    font-size: 0.875em;
    white-space: nowrap;
  }

  .entry-content {
    margin-block: 0.125rem 0;
    margin-inline-start: 1rem;
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
