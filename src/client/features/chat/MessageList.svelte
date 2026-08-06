<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import ActivityList from './ActivityList.svelte';
  import type { HistoryActivity } from './activity-summary.js';
  import type { ChatMessage } from './message-store.js';
  import { groupMessages } from './message-groups.js';
  import { formatElapsedAfter, formatMessageTime } from './message-time.js';
  import { renderCommentary, type CommentaryPart } from './rendering.js';

  let { messages, activities }: { messages: ChatMessage[]; activities: HistoryActivity[] } = $props();
  let groups = $derived(groupMessages(messages));
  let expandedCommentary = $state<Record<string, boolean>>({});
  let latestAnswerId = $derived(
    groups.findLast((group) => group.kind === 'assistant' && group.answer)?.id,
  );
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
    <li class={group.kind === 'user' ? 'prompt-turn' : 'answer-item'}>
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
            {#if group.commentary}
              <button
                class="commentary-toggle"
                type="button"
                aria-expanded={Boolean(expandedCommentary[group.id])}
                aria-controls={`commentary-${group.id}`}
                onclick={() =>
                  (expandedCommentary[group.id] = !expandedCommentary[group.id])}
              >
                <span aria-hidden="true">{expandedCommentary[group.id] ? '⌄' : '>'}</span
                >commentary
              </button>
            {/if}
            {#if group.id === latestAnswerId}
              <ActivityList {activities} />
            {/if}
            {#if group.occurredAt}
              <time datetime={new Date(group.occurredAt).toISOString()}>
                {formatMessageTime(group.occurredAt)}
                {#if formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
                  · {formatElapsedAfter(groups[index - 1]?.occurredAt, group.occurredAt)}
                {/if}
              </time>
            {/if}
          </div>
          {#if group.commentary && expandedCommentary[group.id]}
            <div class="commentary-content" id={`commentary-${group.id}`}>
              {@render content(group.commentary)}
            </div>
          {/if}
          <div class="entry-content">{@render content(group.answer)}</div>
        </section>
      {:else if group.commentary}
        <section class="commentary-turn">
          <div class="entry-heading">
            <details>
              <summary>commentary</summary>
              {@render content(group.commentary)}
            </details>
            <ActivityList {activities} />
          </div>
        </section>
      {/if}
    </li>
  {/each}
</ol>

<style>
  ol {
    inline-size: 100%;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    box-sizing: border-box;
    inline-size: 100%;
    margin-block-end: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  li + li {
    margin-block-start: 1rem;
  }

  .prompt-turn {
    padding: 0.5rem 0.625rem;
    background: var(--theme-surface-subtle);
    border-inline-start: 0.25rem solid var(--theme-accent);
    border-radius: 0.375rem;
  }

  .answer-turn { border-inline-start: 0.25rem solid var(--theme-border); padding-inline-start: 0.625rem; }

  .commentary-turn,
  .commentary-content {
    padding: 0.5rem 0.625rem;
    background: var(--theme-surface-subtle);
    border-inline-start: 0.25rem solid var(--theme-info);
    border-radius: 0.375rem;
  }

  .entry-heading {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  time {
    margin-inline-start: auto;
    color: var(--theme-text-muted);
    font-size: 0.875em;
    white-space: nowrap;
  }

  .commentary-toggle {
    min-block-size: 1.5rem;
    padding: 0 0.125rem;
    color: var(--theme-text-muted);
    background: transparent;
    border: 0;
    font-size: 0.875em;
  }

  .commentary-content { margin-block: 0.25rem 0.5rem; }

  .entry-content {
    margin-block: 0.125rem 0;
    margin-inline: 0;
  }

  pre,
  code {
    font-family: var(--theme-font-code);
  }

  pre {
    padding: 0.625rem;
    white-space: pre;
    overflow-x: auto;
    background: var(--theme-code);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }

  :not(pre) > code { padding-inline: 0.2em; background: var(--theme-code); border-radius: 0.2rem; }

  a { color: var(--theme-info); }

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
    border: 1px solid var(--theme-border);
  }

  th {
    font-weight: 600;
    background: var(--theme-surface-subtle);
  }
</style>
