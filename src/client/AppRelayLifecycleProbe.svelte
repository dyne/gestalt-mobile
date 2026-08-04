<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<svelte:options runes={true} />

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  let { authorizedFetch, passkeyAuthEnabled, onlock }: { authorizedFetch: typeof fetch; passkeyAuthEnabled: boolean; onlock: () => void } = $props();

  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const request = new AbortController();
  const reconcile = () => undefined;

  onMount(() => {
    socket = new WebSocket('ws://relay.test/events');
    timer = setInterval(reconcile, 1_000);
    document.addEventListener('visibilitychange', reconcile);
    window.addEventListener('focus', reconcile);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
    document.removeEventListener('visibilitychange', reconcile);
    window.removeEventListener('focus', reconcile);
    request.abort();
    socket?.close();
  });
</script>

<nav aria-label="Relay navigation">
  <button type="button" onclick={() => void authorizedFetch('/api/probe', { signal: request.signal })}>
    Trigger authorized request
  </button>
  {#if passkeyAuthEnabled}<button type="button" onclick={onlock}>Lock Gestalt Mobile</button>{/if}
</nav>
