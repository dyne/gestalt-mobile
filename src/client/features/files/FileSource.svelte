<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script lang="ts">
  let { text, line }: { text: string; line?: number } = $props();
  let lines = $derived(text.split('\n'));
</script>

<pre aria-label="File source"><code
    >{#each lines as text, index (index)}<span
        class="source-line"
        class:highlighted={index + 1 === line}
        data-line={index + 1}
        aria-label={index + 1 === line ? `Highlighted line ${line}` : undefined}
        ><span class="line-number" aria-hidden="true" data-number={index + 1}></span><span
          class="line-text">{text}{index < lines.length - 1 ? '\n' : ''}</span
        ></span
      >{/each}</code
  ></pre>

<style>
  pre {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.6;
    tab-size: 2;
    min-width: max-content;
  }
  .source-line {
    display: flex;
    min-height: 1.6em;
    border-inline-start: 3px solid transparent;
  }
  .line-number {
    min-width: 4ch;
    padding-inline: 0.5rem 1rem;
    color: var(--theme-text-muted);
    text-align: end;
    user-select: none;
  }
  .line-number::before {
    content: attr(data-number);
  }
  .line-text {
    white-space: pre;
    padding-inline-end: 0.5rem;
  }
  .highlighted {
    background: color-mix(in srgb, var(--theme-accent) 18%, var(--theme-surface));
    border-inline-start-color: var(--theme-accent);
  }
  .highlighted .line-number {
    color: var(--theme-accent);
    font-weight: 700;
  }
</style>
