<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { copyText } from '../sessions/clipboard.js';

  let {
    path,
    oncopyresult = () => {},
  }: {
    path: string;
    oncopyresult?: (copied: boolean) => void;
  } = $props();
</script>

<div class="plan-file-path">
  <code>{path}</code>
  <button
    type="button"
    aria-label="Copy Org file path"
    title="Copy Org file path"
    onclick={async () => oncopyresult(await copyText(path))}
  >
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </svg>
  </button>
</div>

<style>
  .plan-file-path {
    display: flex;
    align-items: flex-start;
    gap: 0.25rem;
    min-inline-size: 0;
    margin-block: 0.25rem 0.5rem;
  }
  code {
    min-inline-size: 0;
    padding-block: 0.65rem;
    overflow-wrap: anywhere;
    color: var(--theme-text-muted);
    font-size: 0.8125rem;
    user-select: all;
  }
  button {
    display: grid;
    place-items: center;
    flex: 0 0 2.75rem;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    padding: 0;
    color: var(--theme-text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.375rem;
  }
  button:hover {
    color: var(--theme-text);
    background: var(--theme-control-hover);
  }
  button:focus-visible {
    outline: 2px solid var(--theme-focus);
    outline-offset: 2px;
  }
  svg {
    inline-size: 1rem;
    block-size: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
