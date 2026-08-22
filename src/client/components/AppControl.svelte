<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    children: Snippet;
    element?: 'button' | 'summary';
    id?: string;
    type?: 'button' | 'submit';
    disabled?: boolean;
    pressed?: boolean;
    describedby?: string;
    ariaDisabled?: boolean;
    state?: string;
    class?: string;
    compact?: boolean;
    full?: boolean;
    primary?: boolean;
    onclick?: (event: MouseEvent & { currentTarget: HTMLButtonElement }) => void;
  };

  let {
    children,
    element = 'button',
    id,
    type = 'button',
    disabled = false,
    pressed,
    describedby,
    ariaDisabled,
    state,
    class: className,
    compact = false,
    full = false,
    primary = false,
    onclick,
  }: Props = $props();
</script>

{#if element === 'summary'}
  <summary {id} class={['app-control', className, { compact, full, primary }]} data-state={state}>
    {@render children()}
  </summary>
{:else}
  <button
    {id}
    {type}
    {disabled}
    class={['app-control', className, { compact, full, primary }]}
    aria-pressed={pressed}
    aria-describedby={describedby}
    aria-disabled={ariaDisabled}
    {onclick}
  >
    {@render children()}
  </button>
{/if}

<style>
  .app-control {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-inline-size: 44px;
    min-block-size: 44px;
    padding: 0.45rem 0.75rem;
    color: var(--theme-text);
    font: inherit;
    text-align: center;
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
    cursor: pointer;
    scroll-margin-block: var(--sticky-header-clearance) var(--bottom-navigation-clearance);
  }

  .app-control:hover:not(:disabled, [aria-disabled='true']) {
    background: var(--theme-control-hover);
  }

  .app-control:active:not(:disabled, [aria-disabled='true']) {
    color: var(--theme-control-pressed-contrast);
    background: var(--theme-control-pressed);
  }

  .app-control:focus-visible {
    outline: 3px solid var(--theme-accent);
    outline-offset: 2px;
  }

  .app-control:disabled,
  .app-control[aria-disabled='true'] {
    color: var(--theme-control-disabled);
    cursor: not-allowed;
    opacity: 0.65;
  }

  .compact {
    padding: 0.25rem 0.4rem;
    font-size: 0.8rem;
  }

  .full {
    inline-size: 100%;
  }

  .primary {
    color: var(--theme-accent-contrast);
    font-weight: 700;
    background: var(--theme-accent);
    border-color: var(--theme-accent);
    box-shadow: inset 0 0.15rem 0 var(--theme-accent-contrast);
  }

  @media (prefers-reduced-motion: reduce) {
    .app-control {
      transition: none !important;
      animation: none !important;
    }
  }
</style>
