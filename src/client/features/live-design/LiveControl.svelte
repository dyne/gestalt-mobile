<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { LiveClient } from './contracts.js';
  import { LiveController, type LiveView } from './live-controller.js';
  import { openPreview } from './open-preview.js';

  let {
    client,
    relayId,
    provider = 'codex',
    notify,
  }: {
    client: LiveClient;
    relayId: string;
    provider?: string;
    notify: (message: string) => void;
  } = $props();
  let view = $state<LiveView>({
    targets: [],
    selection: 0,
    run: null,
    pending: false,
    checking: true,
    uncertainStart: false,
    guidance: 'Checking Live availability…',
  });
  const controller = new LiveController(
    untrack(() => client),
    untrack(() => relayId),
    (next) => (view = next),
    untrack(() => notify),
  );
  let trigger: HTMLButtonElement;
  let panel: HTMLDivElement;
  let popupBlocked = $state(false);
  let disposePreview = () => {};
  const id = $props.id();
  let active = $derived(
    !!view.run && (view.run.state === 'active' || view.run.state === undefined),
  );
  let available = $derived(provider === 'codex' && view.targets.length > 0);

  onDestroy(() => {
    controller.dispose();
    disposePreview();
  });

  function open(): void {
    if (!view.run) return;
    disposePreview();
    const attempt = openPreview(client, relayId, view.run, notify);
    disposePreview = attempt.dispose;
    popupBlocked = !attempt.opened;
    if (popupBlocked)
      notify(
        'Your browser blocked the preview window. Allow pop-ups for Mobile, then choose Open preview again.',
      );
  }
</script>

<button
  bind:this={trigger}
  class="live-trigger"
  type="button"
  popovertarget={id}
  aria-label="Live controls"
>
  Live{#if active}<span class="live-dot" aria-hidden="true"></span>{/if}
</button>
<div
  bind:this={panel}
  {id}
  class="live-panel"
  popover="auto"
  aria-label="Live controls"
  ontoggle={(event) => {
    if (event.newState === 'open') void controller.refresh();
  }}
>
  <div class="live-heading">
    <h2>Live design</h2>
    <button
      type="button"
      class="close-live"
      aria-label="Close Live controls"
      onclick={() => {
        panel.hidePopover();
        trigger.focus();
      }}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></button
    >
  </div>
  <p role="status" aria-live="polite" aria-atomic="true">
    {provider === 'codex'
      ? view.guidance
      : 'Live is available for Codex sessions. This session can continue in chat.'}
  </p>
  {#if active}
    <button class="live-primary" type="button" onclick={open}>Open preview</button>
    {#if popupBlocked}<p>
        Allow pop-ups for Mobile in your browser, then choose Open preview again. Your preview
        access stays private.
      </p>{/if}
  {:else}
    {#if available}
      <label for={`${id}-app`}>Registered app</label>
      <select
        id={`${id}-app`}
        value={view.selection}
        disabled={view.pending || view.uncertainStart}
        onchange={(event) => controller.select(Number(event.currentTarget.value))}
      >
        {#each view.targets as target, index (`${target.appId}:${target.targetId}`)}<option
            value={index}>{target.appId} · {target.targetId}</option
          >{/each}
      </select>
    {/if}
    <button
      class="live-primary"
      type="button"
      disabled={!available || view.pending || view.checking}
      aria-busy={view.pending}
      onclick={() => controller.start()}>{view.pending ? 'Starting Live…' : 'Start Live'}</button
    >
    {#if !view.pending && !available}<button
        type="button"
        class="live-refresh"
        onclick={() => controller.refresh(true)}>Check availability</button
      >{/if}
  {/if}
</div>

<style>
  .live-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 44px;
    padding: 0.35rem 0.65rem;
    color: var(--theme-text);
    background: transparent;
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    font: inherit;
    cursor: pointer;
  }
  .live-dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 50%;
    background: currentColor;
  }
  .live-panel {
    position: fixed;
    inset: auto;
    top: 4.5rem;
    right: 12px;
    margin: 0;
    box-sizing: border-box;
    width: min(26rem, calc(100vw - 24px));
    max-height: calc(100dvh - 6rem);
    overflow-y: auto;
    padding: clamp(12px, 4vw, 1.25rem);
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 12px;
    font-size: 1rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .live-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1.25rem;
    overflow-wrap: normal;
  }
  .live-heading .close-live {
    flex: 0 0 44px;
    display: grid;
    place-items: center;
    padding: 0;
    width: 44px;
    height: 44px;
  }
  .close-live svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }
  .live-panel p[role='status'] {
    text-align: start;
    margin: 1rem 0;
  }
  p {
    margin: 1rem 0;
  }
  label {
    display: block;
    margin-bottom: 0.4rem;
  }
  select {
    display: block;
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    margin-bottom: 1rem;
    padding: 0.5rem;
    font: inherit;
    color: inherit;
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: 8px;
  }
  .live-panel button {
    min-height: 44px;
    padding: 0.5rem 0.75rem;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border: 1px solid var(--theme-border);
    border-radius: 8px;
    background: transparent;
  }
  .live-panel .live-primary {
    width: 100%;
    font-weight: 600;
  }
  .live-panel .live-refresh {
    margin-top: 0.65rem;
    width: 100%;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button:focus-visible,
  select:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
  }
</style>
