<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  type ThemePreference = 'system' | 'light' | 'dark';

  let {
    theme,
    sessionPath = null,
    sessionModel = null,
    weeklyQuotaRemaining = null,
    onthemechange,
    onlock = () => {},
    ondevices = () => {},
  }: {
    theme: ThemePreference;
    sessionPath?: string | null;
    sessionModel?: string | null;
    weeklyQuotaRemaining?: number | null;
    onthemechange: (theme: ThemePreference) => void;
    onlock?: () => void;
    ondevices?: (trigger: HTMLButtonElement) => void;
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
      {sessionPath}{#if sessionModel}<span class="session-model"><small>· {sessionModel}</small></span>{/if}
    </p>
  {/if}
  <div class="header-actions">
    {#if weeklyQuotaRemaining !== null}
      <span class="weekly-quota" aria-label="Weekly quota remaining">{weeklyQuotaRemaining}% left</span>
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

<style>
  .session-path {
    min-inline-size: 0;
    margin: 0;
    overflow: hidden;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-model { margin-inline-start: clamp(0.75rem, 3vw, 2rem); }

  @media (max-width: 34rem) {
    .session-model { display: none; }
  }
</style>

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
      onchange={(event) => onthemechange(event.currentTarget.value as ThemePreference)}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
  <button type="button" popovertarget="configuration-panel" popovertargetaction="hide" onclick={(event) => ondevices(event.currentTarget)}>Authorized devices</button>
  <button type="button" class="lock-relay" popovertarget="configuration-panel" popovertargetaction="hide" onclick={onlock}>Lock Gestalt Mobile</button>
</div>
