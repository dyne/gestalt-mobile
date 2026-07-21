<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import ToastViewport from './ToastViewport.svelte';
  import { createToastQueue } from './toast-queue.js';

  let { variant }: { variant: 'error' | 'stacked' } = $props();
  const queue = createToastQueue();

  onMount(() => {
    if (variant === 'stacked') queue.enqueue({ kind: 'success', message: 'Cloned.' });
    queue.enqueue({
      kind: 'error',
      code: 'GIT_CLONE_FAILED',
      message: 'Clone failed.',
    });
  });
</script>

<main class="evidence-page">
  <h1>Git repository</h1>
  <p>Choose a destination and clone a repository.</p>
  <div class="evidence-composer">
    <label for="evidence-prompt">Prompt</label>
    <textarea id="evidence-prompt" class="evidence-prompt" rows="1"
      >Review repository status</textarea
    >
  </div>
</main>
<nav class="evidence-nav" aria-label="Primary evidence navigation">
  <button type="button">Sessions</button>
  <button type="button" aria-pressed="true">Git</button>
  <button type="button">Chat</button>
</nav>
<ToastViewport {queue} />

<style>
  .evidence-page {
    box-sizing: border-box;
    inline-size: 100%;
    min-block-size: 100dvh;
    padding: 1rem 1rem 7rem;
  }

  h1 {
    margin-block: 0 0.5rem;
  }

  .evidence-composer {
    position: fixed;
    inset-inline: 1rem;
    inset-block-end: 2.75rem;
  }

  .evidence-prompt {
    display: block;
    box-sizing: border-box;
    inline-size: 100%;
    margin-block-start: 0.35rem;
  }

  .evidence-nav {
    position: fixed;
    inset-inline: 0;
    inset-block-end: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    padding: 0.5rem 1rem calc(0.5rem + env(safe-area-inset-bottom));
    background: Canvas;
    border-block-start: 1px solid CanvasText;
  }

  .evidence-nav button {
    min-inline-size: 0;
    min-block-size: 44px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 24rem) {
    .evidence-page {
      padding: 0.5rem 0.5rem 7rem;
    }

    .evidence-composer {
      inset-inline: 0.5rem;
    }
  }
</style>
