<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import type { XerjStatus } from '../../shared/contracts/xerj-status.js';
  import type { ComponentVersion } from '../../shared/contracts/component-version.js';
  import type { HeaderAction } from '../features/sessions/header-actions.js';
  import { themes, type ThemeId } from '../features/theme/theme-registry.js';

  let {
    theme,
    sessionPath = null,
    sessionModel = null,
    weeklyQuotaRemaining = null,
    brandIconUrl = null,
    passkeyAuthEnabled = true,
    componentVersions = [],
    xerj,
    onconfigurationchange = () => {},
    contextualActions = [],
    onthemechange,
    onlock = () => {},
    ondevices = () => {},
    onnotifications = () => {},
    onscratchpad = () => {},
    onquit = async () => {},
    onupgrade = async () => {},
    ondetach,
    oncopytocli,
    copyToCliAvailable = true,
  }: {
    theme: ThemeId;
    sessionPath?: string | null;
    sessionModel?: string | null;
    weeklyQuotaRemaining?: number | null;
    brandIconUrl?: string | null;
    passkeyAuthEnabled?: boolean;
    componentVersions?: readonly ComponentVersion[];
    xerj?: XerjStatus;
    onconfigurationchange?: (open: boolean) => void;
    contextualActions?: readonly HeaderAction[];
    onthemechange: (theme: ThemeId) => void;
    onlock?: () => void;
    ondevices?: (trigger: HTMLButtonElement) => void;
    onnotifications?: () => void;
    onscratchpad?: () => void;
    onquit?: () => Promise<void>;
    onupgrade?: () => Promise<void>;
    ondetach?: () => void;
    oncopytocli?: () => void;
    copyToCliAvailable?: boolean;
  } = $props();

  let menuTrigger = $state<HTMLButtonElement | null>(null);
  let quitDialog = $state<HTMLDialogElement | null>(null);
  let quitCancel = $state<HTMLButtonElement | null>(null);
  let quitPending = $state(false);
  let upgradeDialog = $state<HTMLDialogElement | null>(null);
  let upgradeCancel = $state<HTMLButtonElement | null>(null);
  let upgradePending = $state(false);

  function openUpgrade(): void {
    upgradeDialog?.showModal();
    queueMicrotask(() => upgradeCancel?.focus());
  }

  async function confirmUpgrade(): Promise<void> {
    if (upgradePending) return;
    upgradePending = true;
    try {
      await onupgrade();
    } catch {
      // Failures are reported through the application's shared toast queue.
      upgradePending = false;
    }
  }

  function openQuit(): void {
    quitDialog?.showModal();
    queueMicrotask(() => quitCancel?.focus());
  }

  async function confirmQuit(): Promise<void> {
    quitPending = true;
    try {
      await onquit();
    } catch {
      // The application reports the actionable failure through the shared toast queue.
      quitPending = false;
    }
  }

  function closeQuit(): void {
    if (!quitPending) quitDialog?.close();
  }

  function restoreMenuFocus(): void {
    if (!quitPending && !upgradePending) queueMicrotask(() => menuTrigger?.focus());
  }
</script>

<header class="app-header">
  <a class="brand" href="/" aria-label="Gestalt Mobile">
    {#if brandIconUrl}
      <img class="brand-icon brand-icon-custom" src={brandIconUrl} alt="" />
    {:else}
      <img class="brand-icon light-asset" src="/branding/p_glogo_grey.svg" alt="" />
      <img class="brand-icon dark-asset" src="/branding/p_glogo_white.svg" alt="" />
    {/if}
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
      bind:this={menuTrigger}
      class="menu-trigger"
      type="button"
      popovertarget="configuration-panel"
      aria-label="Open configuration"
    >
      <span class="menu-lines" aria-hidden="true"><span></span><span></span><span></span></span>
    </button>
  </div>
</header>

<div
  id="configuration-panel"
  class="configuration-panel"
  popover="auto"
  ontoggle={(event) => onconfigurationchange(event.newState === 'open')}
>
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
  {#each contextualActions as action (action.id)}
    <button
      type="button"
      popovertarget="configuration-panel"
      popovertargetaction="hide"
      onclick={action.run}>{action.label}</button
    >
  {/each}
  <button
    type="button"
    popovertarget="configuration-panel"
    popovertargetaction="hide"
    onclick={onnotifications}>Notifications</button
  >
  <button
    type="button"
    popovertarget="configuration-panel"
    popovertargetaction="hide"
    onclick={onscratchpad}>Scratchpad</button
  >
  {#if oncopytocli}
    <button
      type="button"
      popovertarget="configuration-panel"
      popovertargetaction="hide"
      disabled={!copyToCliAvailable}
      onclick={oncopytocli}>Copy session to CLI</button
    >
  {/if}
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
  {#if xerj && xerj.state !== 'absent'}
    <section class="component-versions xerj-status" aria-labelledby="xerj-status-title">
      <h2 id="xerj-status-title">Workspace discovery</h2>
      <dl>
        <div>
          <dt>XERJ</dt>
          <dd>{xerj.state}</dd>
        </div>
        <div>
          <dt>Root</dt>
          <dd class="xerj-root">{xerj.root}</dd>
        </div>
        {#if xerj.phase}<div>
            <dt>Phase</dt>
            <dd>
              {xerj.phase}{xerj.percent === undefined ? '' : ` · ${Math.round(xerj.percent)}%`}
            </dd>
          </div>{/if}
        {#if xerj.files !== undefined}<div>
            <dt>Files</dt>
            <dd>{xerj.files.toLocaleString()}</dd>
          </div>{/if}
        {#if xerj.records !== undefined}<div>
            <dt>Records</dt>
            <dd>{xerj.records.toLocaleString()}</dd>
          </div>{/if}
        {#if xerj.lastUpdate}<div>
            <dt>Last update</dt>
            <dd>
              <time datetime={xerj.lastUpdate}>{new Date(xerj.lastUpdate).toLocaleString()}</time>
            </dd>
          </div>{/if}
      </dl>
      {#if xerj.message}<p>{xerj.message}</p>{/if}
    </section>
  {/if}
  {#if componentVersions.length}
    <section class="component-versions" aria-labelledby="component-versions-title">
      <h2 id="component-versions-title">Versions</h2>
      <dl>
        {#each componentVersions as component (component.id)}
          <div>
            <dt>{component.label}</dt>
            <dd title={component.version ?? 'Version unavailable'}>
              {component.version ?? 'Unavailable'}
            </dd>
          </div>
        {/each}
      </dl>
    </section>
  {/if}
  <div class="maintenance-actions">
    <button
      type="button"
      popovertarget="configuration-panel"
      popovertargetaction="hide"
      disabled={upgradePending || quitPending}
      onclick={openUpgrade}>Upgrade</button
    >
    <button
      type="button"
      popovertarget="configuration-panel"
      popovertargetaction="hide"
      class="quit-relay"
      disabled={upgradePending}
      onclick={openQuit}>Quit</button
    >
  </div>
</div>

<dialog
  bind:this={quitDialog}
  aria-labelledby="quit-title"
  aria-describedby="quit-description"
  aria-busy={quitPending}
  oncancel={(event) => (quitPending ? event.preventDefault() : restoreMenuFocus())}
  onclose={restoreMenuFocus}
>
  <h2 id="quit-title">Quit Gestalt Mobile?</h2>
  <p id="quit-description">
    This stops Gestalt Mobile and every session process it started, including work that is currently
    running. Saved sessions remain available the next time Gestalt Mobile starts.
  </p>
  <div class="dialog-actions">
    <button bind:this={quitCancel} type="button" disabled={quitPending} onclick={closeQuit}
      >Cancel</button
    >
    <button
      class="confirm-quit"
      type="button"
      disabled={quitPending}
      onclick={() => void confirmQuit()}>{quitPending ? 'Quitting…' : 'Quit'}</button
    >
  </div>
</dialog>

<dialog
  bind:this={upgradeDialog}
  aria-labelledby="upgrade-title"
  aria-describedby="upgrade-description"
  aria-busy={upgradePending}
  oncancel={(event) => (upgradePending ? event.preventDefault() : restoreMenuFocus())}
  onclose={restoreMenuFocus}
>
  <h2 id="upgrade-title">Upgrade Gestalt?</h2>
  <p id="upgrade-description">
    Update Gestalt and restart Mobile with its current settings. Running work will be interrupted
    when Mobile restarts. Saved sessions are preserved, and this page will reconnect automatically.
  </p>
  {#if upgradePending}<p role="status">Updating and waiting for Mobile to reconnect…</p>{/if}
  <div class="dialog-actions">
    <button
      bind:this={upgradeCancel}
      type="button"
      disabled={upgradePending}
      onclick={() => upgradeDialog?.close()}>Cancel</button
    >
    <button type="button" disabled={upgradePending} onclick={() => void confirmUpgrade()}>
      {upgradePending ? 'Upgrading…' : 'Upgrade and restart'}
    </button>
  </div>
</dialog>

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

  .maintenance-actions {
    margin-block-start: 0.5rem;
    padding-block-start: 0.5rem;
    border-block-start: 1px solid var(--theme-border);
  }

  .component-versions {
    margin-block-start: 0.75rem;
    padding-block-start: 0.75rem;
    border-block-start: 1px solid var(--theme-border);
  }

  .component-versions h2 {
    margin: 0 0 0.4rem;
    color: var(--theme-text-muted);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .component-versions dl {
    display: grid;
    gap: 0.25rem;
    margin: 0;
  }

  .component-versions dl > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(5rem, auto);
    align-items: baseline;
    gap: 0.75rem;
  }

  .component-versions dt,
  .component-versions dd {
    min-inline-size: 0;
    margin: 0;
    font-size: 0.75rem;
  }

  .component-versions dt {
    color: var(--theme-text-muted);
  }

  .component-versions dd {
    overflow: hidden;
    font-family: var(--theme-font-code);
    font-variant-numeric: tabular-nums;
    text-align: end;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .xerj-status dl > div {
    grid-template-columns: max-content minmax(0, 1fr);
  }

  .xerj-status .xerj-root {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .xerj-status p {
    margin-block: 0.5rem 0;
    color: var(--theme-text-muted);
    font-size: 0.75rem;
  }

  .maintenance-actions button {
    inline-size: 100%;
  }

  .quit-relay,
  .confirm-quit {
    color: var(--theme-error);
  }

  dialog {
    box-sizing: border-box;
    inline-size: min(28rem, calc(100vw - 2rem));
    padding: 1.25rem;
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
    box-shadow: 0 1rem 2.5rem var(--theme-shadow);
  }

  dialog::backdrop {
    background: color-mix(in srgb, var(--theme-page) 58%, transparent);
  }

  dialog h2 {
    margin-block: 0 0.5rem;
  }

  dialog p {
    margin-block: 0 1.25rem;
    color: var(--theme-text-muted);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
  }

  .dialog-actions button:last-child {
    font-weight: 700;
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
