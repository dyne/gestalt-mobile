<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { renderCommentary, type CommentaryPart } from './rendering.js';
  import {
    localFilePathFromHref,
    localFileReferenceFromHref,
  } from '../../../shared/contracts/local-file-link.js';
  import { isLocalOrgHref } from '../plans/org-plan-link.js';
  import { copyText } from '../sessions/clipboard.js';
  let {
    text,
    onopenorg,
    onopenfile,
    oncopyresult = () => {},
    clipboard = globalThis.navigator?.clipboard,
  }: {
    text: string;
    onopenorg?: (href: string) => void;
    onopenfile?: (path: string, line?: number) => void;
    oncopyresult?: (copied: boolean) => void;
    clipboard?: Pick<Clipboard, 'writeText'>;
  } = $props();
  function openOrg(event: MouseEvent, href: string): void {
    if (!onopenorg || !isLocalOrgHref(href)) return;
    event.preventDefault();
    onopenorg(href);
  }
  function codeCopyLabel(text: string): string {
    const preview = text.trim().split('\n')[0]?.trim() || 'empty block';
    return `Copy code block: ${preview.slice(0, 48)}`;
  }
  async function copyCode(text: string): Promise<void> {
    oncopyresult(await copyText(text, clipboard));
  }
</script>

{#snippet inline(parts: CommentaryPart[])}
  {#each parts as part, partIndex (partIndex)}
    {#if part.kind === 'link'}
      {#if onopenorg && isLocalOrgHref(part.href)}
        <a href={part.href} onclick={(event) => openOrg(event, part.href)}>{part.text}</a>
      {:else if onopenfile && localFilePathFromHref(part.href)}
        <a
          href={part.href}
          onclick={(event) => {
            event.preventDefault();
            const reference = localFileReferenceFromHref(part.href)!;
            if (reference.line) onopenfile?.(reference.path, reference.line);
            else onopenfile?.(reference.path);
          }}>{part.text}</a
        >
      {:else}
        <a href={part.href} target="_blank" rel="noreferrer">{part.text}</a>
      {/if}
    {:else if part.kind === 'code'}
      <code>{part.text}</code>
    {:else if part.kind === 'strong'}
      <strong>{@render inline(part.parts)}</strong>
    {:else}
      {part.text}
    {/if}
  {/each}
{/snippet}

<div class="message-content">
  {#each renderCommentary(text) as block, blockIndex (blockIndex)}
    {#if block.kind === 'code'}
      <div class="code-block">
        <button
          class="code-copy"
          type="button"
          aria-label={codeCopyLabel(block.text)}
          title="Copy code"
          onclick={() => void copyCode(block.text)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
          </svg>
        </button>
        <pre><code>{block.text}</code></pre>
      </div>
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
    {:else if block.kind === 'heading'}
      {#if block.level === 1}
        <h1>{@render inline(block.parts)}</h1>
      {:else if block.level === 2}
        <h2>{@render inline(block.parts)}</h2>
      {:else if block.level === 3}
        <h3>{@render inline(block.parts)}</h3>
      {:else if block.level === 4}
        <h4>{@render inline(block.parts)}</h4>
      {:else if block.level === 5}
        <h5>{@render inline(block.parts)}</h5>
      {:else}
        <h6>{@render inline(block.parts)}</h6>
      {/if}
    {:else}
      <div>{@render inline(block.parts)}</div>
    {/if}
  {/each}
</div>

<style>
  .message-content {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    min-inline-size: 0;
  }
  :is(h1, h2, h3, h4, h5, h6) {
    margin-block: 0.85em 0.3em;
    line-height: 1.25;
    text-wrap: balance;
  }

  :is(h1, h2, h3):first-child {
    margin-block-start: 0.25em;
  }

  h1 {
    font-size: 1.5em;
  }

  h2 {
    font-size: 1.3em;
  }

  h3 {
    font-size: 1.15em;
  }

  :is(h4, h5, h6) {
    font-size: 1em;
  }

  pre,
  code {
    font-family: var(--theme-font-code);
  }

  pre {
    margin: 0;
    padding: 0.625rem;
    padding-inline-end: 3rem;
    white-space: pre;
    overflow-x: auto;
    background: var(--theme-code);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
  }

  .code-block {
    position: relative;
    margin-block: 0.75rem;
  }

  .code-copy {
    position: absolute;
    inset-block-start: 0.375rem;
    inset-inline-end: 0.375rem;
    z-index: 1;
    display: grid;
    place-items: center;
    inline-size: 2rem;
    min-block-size: 2rem;
    padding: 0;
    color: var(--theme-text-muted);
    background: var(--theme-surface-subtle);
    border: 1px solid var(--theme-border);
    border-radius: 0.375rem;
  }

  .code-copy:hover {
    color: var(--theme-text);
    background: var(--theme-control-hover);
  }

  .code-copy:focus-visible {
    color: var(--theme-text);
    outline: 2px solid var(--theme-focus);
    outline-offset: 2px;
  }

  .code-copy svg {
    inline-size: 1rem;
    block-size: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  :not(pre) > code {
    padding-inline: 0.2em;
    background: var(--theme-code);
    border-radius: 0.2rem;
  }

  a {
    color: var(--theme-info);
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
    border: 1px solid var(--theme-border);
  }

  th {
    font-weight: 600;
    background: var(--theme-surface-subtle);
  }

  @media (pointer: coarse) {
    pre {
      padding-inline-end: 3.75rem;
    }

    .code-copy {
      inline-size: 2.75rem;
      min-block-size: 2.75rem;
    }
  }
</style>
