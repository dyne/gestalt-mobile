<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { NotificationHistoryItem, ToastQueue } from './toast-queue.js';

  let { queue, onclose }: { queue: ToastQueue; onclose: () => void } = $props();
  let items = $state.raw<NotificationHistoryItem[]>([]);

  const dateTime = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  onMount(() => {
    const unsubscribe = queue.subscribeHistory((value) => (items = value));
    return unsubscribe;
  });

  function focusOnAttach(element: HTMLElement): void {
    void tick().then(() => element.focus());
  }
</script>

<main class="notification-history" aria-labelledby="notification-history-title">
  <header>
    <button type="button" onclick={onclose}>Back</button>
    <div>
      <h1 id="notification-history-title" tabindex="-1" {@attach focusOnAttach}>
        Recent notifications
      </h1>
      <p>The latest notifications saved in this browser.</p>
    </div>
  </header>

  {#if items.length}
    <ol aria-label="Recent notifications">
      {#each items as item (item.id)}
        <li data-kind={item.kind}>
          <div class="notification-meta">
            <strong>{item.kind}</strong>
            <time datetime={new Date(item.updatedAt).toISOString()}>
              {dateTime.format(item.updatedAt)}
            </time>
          </div>
          <p>{item.message}</p>
          {#if item.occurrences > 1}<small>Repeated {item.occurrences} times.</small>{/if}
        </li>
      {/each}
    </ol>
  {:else}
    <p class="empty" role="status">No recent notifications.</p>
  {/if}
</main>

<style>
  .notification-history {
    box-sizing: border-box;
    inline-size: min(48rem, 100%);
    min-block-size: 100dvh;
    margin: auto;
    padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
      max(5rem, calc(1rem + env(safe-area-inset-bottom))) max(1rem, env(safe-area-inset-left));
    color: var(--theme-text);
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    margin-block-end: 1.5rem;
  }

  header button {
    flex: 0 0 auto;
    min-block-size: 44px;
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-family: var(--theme-font-display);
  }

  header p,
  time,
  small {
    color: var(--theme-text-muted);
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--theme-surface);
    border-block: 1px solid var(--theme-border);
  }

  li {
    display: grid;
    gap: 0.4rem;
    padding: 1rem 0.75rem;
    border-block-end: 1px solid var(--theme-border);
  }

  li:last-child {
    border-block-end: 0;
  }

  .notification-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }

  .notification-meta strong {
    color: var(--theme-info);
    text-transform: capitalize;
  }

  li[data-kind='error'] .notification-meta strong {
    color: var(--theme-error);
  }

  li[data-kind='success'] .notification-meta strong {
    color: var(--theme-success);
  }

  li[data-kind='warning'] .notification-meta strong {
    color: var(--theme-warning);
  }

  time {
    font-variant-numeric: tabular-nums;
  }

  .empty {
    padding: 2rem 1rem;
    color: var(--theme-text-muted);
    text-align: center;
    border-block: 1px solid var(--theme-border);
  }

  @media (forced-colors: active) {
    ol,
    li,
    .empty {
      border-color: CanvasText;
    }
  }
</style>
