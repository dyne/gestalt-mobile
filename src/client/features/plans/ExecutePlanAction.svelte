<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import AppControl from '../../components/AppControl.svelte';
  import type { createRelayClient, RelaySession } from '../sessions/relay-client.js';
  import { displayWorkspacePath } from '../sessions/session-list.js';
  import { isSessionStatus } from '../sessions/session-status.js';
  import SessionActivityStatus from '../sessions/SessionActivityStatus.svelte';
  import type {
    OrgPlanReference,
    OrgPlanPreparation,
    OrgPlanLaunchResult,
  } from '../../../shared/contracts/org-plan-execution.js';
  import { OrgPlanLaunchController } from './org-plan-launch-controller.js';

  type Eligible = Extract<OrgPlanPreparation, { kind: 'eligible' }>;
  export type ExecutePlanTransport = Pick<
    ReturnType<typeof createRelayClient>,
    'prepareOrgPlanSupervision' | 'startOrgPlanSupervision'
  > &
    Partial<Pick<ReturnType<typeof createRelayClient>, 'getSession'>>;
  type Props = {
    reference?: OrgPlanReference;
    sourceVersion?: unknown;
    transport?: ExecutePlanTransport;
    onerror?: (message: string) => void;
    onresult?: (result: OrgPlanLaunchResult) => void;
  };
  let { reference, sourceVersion, transport, onerror, onresult }: Props = $props();
  const id = $props.id();
  let preparation = $state<OrgPlanPreparation | null>(null);
  let loading = $state(true);
  let validating = $state(false);
  let submitting = $state(false);
  let selected = $state('');
  let confirmed = $state<Eligible | null>(null);
  let existingSession = $state<RelaySession | null>(null);
  let problem = $state('');
  let blocked = $state(false);
  let dialog = $state<HTMLDialogElement>();
  let trigger: HTMLButtonElement | undefined;
  let profileSelect: HTMLSelectElement | undefined;
  let initialFocusPending = false;
  let dialogGeneration = 0;
  let generation = 0;
  let validationGeneration = 0;
  let disposed = false;
  const launcher = new OrgPlanLaunchController(
    { startOrgPlanSupervision: (input) => transport!.startOrgPlanSupervision(input) },
    () => crypto.randomUUID(),
    (state) => {
      submitting = state.submitting;
    },
  );
  let busy = $derived(validating || submitting);
  let existingStatus = $derived(
    isSessionStatus(existingSession?.sessionStatus) ? existingSession.sessionStatus : undefined,
  );
  let canReplace = $derived(
    confirmed?.workspaceSession?.replaceAllowed &&
      existingSession?.id === confirmed.workspaceSession.sessionId &&
      existingStatus?.state === 'idle',
  );
  let reason = $derived(
    loading
      ? 'Checking whether this plan can be executed…'
      : preparation?.kind === 'blocked'
        ? preparation.reason
        : !preparation
          ? 'Execution availability could not be verified.'
          : '',
  );
  let validSelection = $derived(
    selected === '' ||
      confirmed?.skillProfiles.some((profile) => profile.name === selected && !profile.error),
  );

  function report(message: string, disallow = false): void {
    blocked = disallow;
    problem = message;
    onerror?.(message);
  }
  function reportBlocked(result: Extract<OrgPlanPreparation, { kind: 'blocked' }>): void {
    if (result.code === 'SKILL_PROFILE_UNAVAILABLE' && selected && confirmed) {
      confirmed = {
        ...confirmed,
        skillProfiles: confirmed.skillProfiles.filter((profile) => profile.name !== selected),
      };
      report(result.reason);
    } else report(result.reason, true);
  }
  async function readWorkspaceSession(
    result: OrgPlanPreparation,
    api: ExecutePlanTransport,
  ): Promise<RelaySession | null> {
    if (result.kind !== 'eligible' || !result.workspaceSession || !api.getSession) return null;
    const session = await api.getSession(result.workspaceSession.sessionId);
    return session.id === result.workspaceSession.sessionId ? session : null;
  }
  $effect(() => {
    const ref = reference;
    const api = transport;
    void sourceVersion;
    return untrack(() => {
      const current = ++generation;
      const request = new AbortController();
      preparation = null;
      loading = true;
      ++validationGeneration;
      validating = false;
      initialFocusPending = false;
      ++dialogGeneration;
      confirmed = null;
      existingSession = null;
      blocked = true;
      if (dialog?.open) dialog.close();
      if (!ref || !api) {
        loading = false;
        return;
      }
      void api
        .prepareOrgPlanSupervision(ref, undefined, undefined, request.signal)
        .then(async (result) => {
          if (current !== generation || disposed) return;
          let occupant: RelaySession | null = null;
          try {
            occupant = await readWorkspaceSession(result, api);
          } catch (error) {
            if (current === generation && !disposed)
              report(error instanceof Error ? error.message : 'Could not check session status.');
          }
          if (current === generation && !disposed) {
            preparation = result;
            existingSession = occupant;
          }
        })
        .catch((error) => {
          if (!request.signal.aborted && current === generation)
            report(error instanceof Error ? error.message : 'Could not check plan execution.');
        })
        .finally(() => {
          if (current === generation && !disposed) loading = false;
        });
      return () => request.abort();
    });
  });
  onDestroy(() => {
    disposed = true;
    ++generation;
    launcher.dispose();
  });

  async function open(event: MouseEvent & { currentTarget: HTMLButtonElement }): Promise<void> {
    if (preparation?.kind !== 'eligible' || busy) return;
    trigger = event.currentTarget;
    confirmed = preparation;
    selected = preparation.settings.skillProfile;
    problem = '';
    blocked = false;
    const openedGeneration = generation;
    const openedDialog = ++dialogGeneration;
    initialFocusPending = true;
    dialog?.showModal();
    await tick();
    if (
      initialFocusPending &&
      openedDialog === dialogGeneration &&
      openedGeneration === generation &&
      !disposed &&
      dialog?.open &&
      !busy
    )
      profileSelect?.focus();
    if (openedDialog === dialogGeneration) initialFocusPending = false;
  }
  async function refreshAvailability(): Promise<void> {
    if (!dialog?.open || !confirmed || !transport || busy) return;
    const current = generation;
    const snapshot = confirmed;
    const validation = ++validationGeneration;
    validating = true;
    try {
      const fresh = await transport.prepareOrgPlanSupervision(
        snapshot.reference,
        snapshot.revision,
        selected,
      );
      const occupant = await readWorkspaceSession(fresh, transport);
      if (
        current !== generation ||
        validation !== validationGeneration ||
        disposed ||
        !dialog?.open
      )
        return;
      if (fresh.kind === 'blocked') reportBlocked(fresh);
      else {
        preparation = fresh;
        confirmed = fresh;
        existingSession = occupant;
        problem = '';
        blocked = false;
      }
    } catch (error) {
      if (
        current === generation &&
        validation === validationGeneration &&
        !disposed &&
        dialog?.open
      )
        report(error instanceof Error ? error.message : 'Could not refresh plan execution.', true);
    } finally {
      if (!disposed && current === generation && validation === validationGeneration)
        validating = false;
    }
  }
  function dismiss(): void {
    initialFocusPending = false;
    ++dialogGeneration;
    if (!submitting) {
      ++validationGeneration;
      validating = false;
    }
    if (dialog?.open) dialog.close();
  }
  async function restoreFocus(): Promise<void> {
    await tick();
    if (trigger?.isConnected) trigger.focus();
  }
  async function confirm(replaceSessionId?: string): Promise<void> {
    if (busy || blocked || !confirmed || !transport || !validSelection) return;
    const occupant = confirmed.workspaceSession;
    if (occupant && (!canReplace || occupant.sessionId !== replaceSessionId)) return;
    const current = generation;
    const snapshot = confirmed;
    try {
      const result = await launcher.submit({
        reference: snapshot.reference,
        expectedRevision: snapshot.revision,
        skillProfile: selected,
        ...(replaceSessionId ? { replaceSessionId } : {}),
      });
      if (disposed || current !== generation) return;
      if (!result) {
        report(
          launcher.state.error ??
            'The launch response was not received. Retry OK to recover the same launch.',
        );
        return;
      }
      if (result.kind === 'blocked' || result.kind === 'rejected') {
        if (result.kind === 'blocked') reportBlocked(result);
        else report(result.reason, true);
        return;
      }
      if (result.kind === 'partial') report(result.reason);
      if (dialog?.open) dialog.close();
      onresult?.(result);
    } catch (error) {
      if (!disposed && current === generation)
        report(error instanceof Error ? error.message : 'Could not start supervision.');
    }
  }
</script>

<svelte:window
  onkeydown={() => {
    if (dialog?.open) initialFocusPending = false;
  }}
/>

<div class="execute-action">
  <AppControl
    compact
    class="execute-trigger"
    primary={!reason}
    disabled={!!reason || submitting}
    describedby={reason ? `${id}-reason` : undefined}
    onclick={open}>Execute</AppControl
  >
  {#if reason}<span id={`${id}-reason`} class="reason">{reason}</span>{/if}
</div>
<dialog
  bind:this={dialog}
  aria-labelledby={`${id}-title`}
  aria-describedby={`${id}-description`}
  onclose={() => void restoreFocus()}
  oncancel={dismiss}
  onkeydown={() => {
    initialFocusPending = false;
  }}
  onpointerdown={() => {
    initialFocusPending = false;
  }}
>
  <h2 id={`${id}-title`}>Execute plan</h2>
  <p id={`${id}-description`}>Start a supervisor session for this plan.</p>
  <label for={`${id}-profile`}>Supervisor Skill profile</label>
  <select
    id={`${id}-profile`}
    bind:this={profileSelect}
    bind:value={selected}
    disabled={busy}
    onchange={() => {
      if (!blocked) problem = '';
    }}
  >
    {#if selected && !confirmed?.skillProfiles.some((profile) => profile.name === selected && !profile.error)}<option
        value={selected}
        disabled>{selected} (unavailable)</option
      >{/if}
    {#each confirmed?.skillProfiles.filter((profile) => !profile.error) ?? [] as profile (profile.name)}<option
        value={profile.name}>{profile.name}</option
      >{/each}
    <option value="">None</option>
  </select>
  {#each confirmed && confirmed.settings.skillProfile === selected ? confirmed.warnings : [] as warning}<p
      class="guidance"
    >
      {warning}
    </p>{/each}
  {#if confirmed?.workspaceSession}
    <section class="workspace-conflict" aria-labelledby={`${id}-workspace-conflict`}>
      <h3 id={`${id}-workspace-conflict`}>Session open in this workspace</h3>
      <p>{displayWorkspacePath(existingSession?.workspacePath ?? confirmed.workspace.path)}</p>
      {#if existingSession?.model}<p>Model: {existingSession.model}</p>{/if}
      {#if existingStatus}
        <SessionActivityStatus status={existingStatus} />
      {:else}
        <p>{validating ? 'Checking session status…' : 'Session status unavailable.'}</p>
      {/if}
      {#if confirmed.workspaceSession.retryClose}
        <p>
          The previous session is saved. Gestalt must confirm it has closed before starting the
          supervisor.
        </p>
      {:else if canReplace}
        <p>
          Replace closes this idle session and starts the supervisor. The previous session and its
          history stay saved.
        </p>
      {:else}
        <p>Replacement requires a confirmed idle session. Refresh to check again.</p>
      {/if}
    </section>
  {/if}
  {#if problem}<p class="guidance" role="status">{problem}</p>{/if}
  {#if !validSelection}<p class="guidance">Choose an available skill profile.</p>{/if}
  {#if submitting}<p class="guidance" role="status">
      Starting supervision. Closing this dialog does not cancel the launch; the session remains
      available in Sessions.
    </p>{:else if validating}<p class="guidance" role="status">
      Checking plan and skill profiles…
    </p>{/if}
  <div class="dialog-actions">
    <AppControl onclick={dismiss}>{submitting ? 'Close' : 'Cancel'}</AppControl>
    {#if problem || (confirmed?.workspaceSession && !canReplace)}<AppControl
        disabled={busy}
        icon="refresh"
        label="Refresh"
        onclick={() => void refreshAvailability()}
      />{/if}
    {#if confirmed?.workspaceSession}
      {@const occupant = confirmed.workspaceSession}
      <AppControl
        primary
        disabled={busy || blocked || !validSelection || !canReplace}
        onclick={() => void confirm(occupant.sessionId)}
        >{submitting ? 'Starting…' : 'Replace and execute'}</AppControl
      >
    {:else}
      <AppControl
        primary
        disabled={busy || blocked || !validSelection}
        onclick={() => void confirm()}>{submitting ? 'Starting…' : 'OK'}</AppControl
      >
    {/if}
  </div>
</dialog>

<style>
  .execute-action {
    display: contents;
  }
  .execute-action > :global(.execute-trigger) {
    grid-column: 2;
    grid-row: 1;
    justify-self: end;
    white-space: nowrap;
  }
  .reason {
    grid-column: 1 / -1;
    grid-row: 2;
    color: var(--theme-text-muted);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .workspace-conflict {
    margin-block: 0.75rem;
    padding: 0.75rem;
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
    overflow-wrap: anywhere;
  }
  .workspace-conflict :is(h3, p) {
    margin: 0 0 0.4rem;
  }
  dialog {
    box-sizing: border-box;
    inline-size: min(28rem, calc(100vw - 2rem));
    max-block-size: calc(100dvh - 2rem);
    overflow: auto;
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
  h2 {
    overflow-wrap: anywhere;
    margin-block: 0 0.5rem;
  }
  p {
    overflow-wrap: anywhere;
  }
  label {
    display: block;
    margin-block: 1rem 0.4rem;
    font-weight: 700;
  }
  select {
    box-sizing: border-box;
    inline-size: 100%;
    min-block-size: 44px;
    font: inherit;
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
    padding: 0.5rem;
  }
  .guidance {
    color: var(--theme-text-muted);
  }
  .dialog-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-block-start: 1.25rem;
  }
  @media (max-width: 40rem) {
    .execute-action > :global(.execute-trigger) {
      grid-row: 2;
    }
    .reason {
      grid-row: 3;
    }
    dialog {
      inline-size: calc(100vw - 0.5rem);
      max-block-size: calc(100dvh - 0.5rem);
      padding: 0.5rem;
    }
    select {
      padding: 0.25rem;
    }
    dialog > p {
      margin-block: 0.5rem;
    }
    label {
      margin-block: 0.5rem 0.25rem;
    }
    .dialog-actions {
      gap: 0.5rem;
      margin-block-start: 0.5rem;
    }
  }
  @media (max-width: 24rem) {
    .execute-action > :global(.execute-trigger) {
      grid-row: 3;
    }
    .reason {
      grid-row: 4;
    }
  }
</style>
