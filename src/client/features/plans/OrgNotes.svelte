<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<script lang="ts">
  let { text, onreference }: { text: string; onreference?: (path: string) => void } = $props();
  let parts = $derived(text.split(/(=[^=\n]+=)/g));
</script>

<span class="notes"
  >{#each parts as part, index (index)}{#if part.startsWith('=') && part.endsWith('=') && part.length > 2 && onreference}<a
        href={`#file-preview=${encodeURIComponent(part.slice(1, -1).trim())}`}
        onclick={(event) => {
          event.preventDefault();
          onreference?.(part.slice(1, -1).trim());
        }}><code>{part.slice(1, -1)}</code></a
      >{:else}{part}{/if}{/each}</span
>

<style>
  .notes {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  a {
    color: var(--theme-accent);
    text-underline-offset: 0.2em;
  }
  code {
    font-size: 0.93em;
  }
  a:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
  }
</style>
