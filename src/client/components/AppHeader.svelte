<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { themes, type ThemeId } from '../features/theme/theme-registry.js';

  let {
    theme,
    sessionPath = null,
    sessionModel = null,
    weeklyQuotaRemaining = null,
    passkeyAuthEnabled = true,
    onthemechange,
    onlock = () => {},
    ondevices = () => {},
    onscratchpad = () => {},
    ondetach,
  }: {
    theme: ThemeId;
    sessionPath?: string | null;
    sessionModel?: string | null;
    weeklyQuotaRemaining?: number | null;
    passkeyAuthEnabled?: boolean;
    onthemechange: (theme: ThemeId) => void;
    onlock?: () => void;
    ondevices?: (trigger: HTMLButtonElement) => void;
    onscratchpad?: () => void;
    ondetach?: () => void;
  } = $props();
</script>

<header class="app-header">
  <a class="brand" href="/" aria-label="Gestalt Mobile">
    <img class="brand-icon light-asset" src="/branding/p_glogo_grey.svg" alt="" />
    <img class="brand-icon dark-asset" src="/branding/p_glogo_white.svg" alt="" />
    <img class="brand-logotype light-asset" src="/branding/t_glogo_grey.svg" alt="" />
    <img class="brand-logotype dark-asset" src="/branding/t_glogo_white.svg" alt="" />
  </a>
  {#if sessionPath}
    <p class="session-path" title={sessionPath}>
      {sessionPath}{#if sessionModel}<span class="session-model"
          ><small>· {sessionModel}</small></span
        >{/if}
    </p>
  {/if}
  <div class="header-actions">
    {#if weeklyQuotaRemaining !== null}
      <span class="weekly-quota" aria-label="Weekly quota remaining"
        >{weeklyQuotaRemaining}% left</span
      >
    {/if}
    {#if ondetach}
      <button
        class="detach-chat"
        type="button"
        aria-label="Open Chat in a separate window"
        title="Open Chat in a separate window"
        onclick={ondetach}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M14 5h5v5M19 5l-8 8" />
          <path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
      </button>
    {/if}
    <button
      class="menu-trigger"
      type="button"
      popovertarget="configuration-panel"
      aria-label="Open configuration"
    >
      <span class="menu-lines" aria-hidden="true"><span></span><span></span><span></span></span>
    </button>
  </div>
</header>

<div id="configuration-panel" class="configuration-panel" popover="auto">
  <div class="configuration-brand" aria-label="Dyne">
    <img class="configuration-logo light-asset" src="/branding/dyne-logotype-black.svg" alt="" />
    <img class="configuration-logo dark-asset" src="/branding/dyne-logotype-white.svg" alt="" />
  </div>
  <label class="appearance-control" for="appearance">
    <span aria-hidden="true">aA</span>
    <select
      id="appearance"
      aria-label="Appearance"
      value={theme}
      onchange={(event) => onthemechange(event.currentTarget.value as ThemeId)}
    >
      {#each themes as option (option.id)}
        <option value={option.id}>{option.label}</option>
      {/each}
    </select>
  </label>
  <button
    type="button"
    popovertarget="configuration-panel"
    popovertargetaction="hide"
    onclick={onscratchpad}>Scratchpad</button
  >
  {#if passkeyAuthEnabled}
    <button
      type="button"
      popovertarget="configuration-panel"
      popovertargetaction="hide"
      onclick={(event) => ondevices(event.currentTarget)}>Authorized devices</button
    >
    <button
      type="button"
      class="lock-relay"
      popovertarget="configuration-panel"
      popovertargetaction="hide"
      onclick={onlock}>Lock Gestalt Mobile</button
    >
  {/if}
</div>

<style>
  .session-path {
    flex: 1 1 0;
    min-inline-size: 0;
    margin: 0;
    overflow: hidden;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-model {
    margin-inline-start: clamp(0.75rem, 3vw, 2rem);
    color: var(--theme-text-muted);
    font-family: var(--theme-font-code);
  }

  .detach-chat {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    inline-size: 44px;
    min-block-size: 44px;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
  }

  .detach-chat svg {
    inline-size: 1.25rem;
    block-size: 1.25rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.75;
  }

  @media (max-width: 34rem) {
    .session-path {
      font-size: max(0.625rem, 12px);
    }
    .session-model {
      display: none;
    }
  }
</style>
