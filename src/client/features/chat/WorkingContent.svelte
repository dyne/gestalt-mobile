<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import MessageContent from './MessageContent.svelte';
  import { newestFirstWorkingParagraphs } from './working-paragraphs.js';

  let {
    text,
    onopenorg,
    onopenfile,
    oncopyresult,
    clipboard,
  }: {
    text: string;
    onopenorg?: (href: string) => void;
    onopenfile?: (path: string, line?: number) => void;
    oncopyresult?: (copied: boolean) => void;
    clipboard?: Pick<Clipboard, 'writeText'>;
  } = $props();
  let paragraphs = $derived(newestFirstWorkingParagraphs(text));
</script>

<div class="working-content">
  {#each paragraphs as paragraph (paragraph.offset)}
    <MessageContent text={paragraph.text} {onopenorg} {onopenfile} {oncopyresult} {clipboard} />
  {/each}
</div>

<style>
  .working-content {
    display: grid;
    gap: 0.75rem;
    min-inline-size: 0;
  }
</style>
