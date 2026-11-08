<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import AppControl from '../../components/AppControl.svelte';
  import type { createRelayClient } from '../sessions/relay-client.js';
  import type {
    OrgPlanReference,
    OrgPlanPreparation,
    OrgPlanLaunchResult,
  } from '../../../shared/contracts/org-plan-execution.js';
  import { OrgPlanLaunchController } from './org-plan-launch-controller.js';

  type Eligible = Extract<OrgPlanPreparation, { kind: 'eligible' }>;
  type Props = {
    reference?: OrgPlanReference;
    sourceVersion?: unknown;
    transport?: Pick<
      ReturnType<typeof createRelayClient>,
      'prepareOrgPlanSupervision' | 'startOrgPlanSupervision'
    >;
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
      blocked = true;
      if (dialog?.open) dialog.close();
      if (!ref || !api) {
        loading = false;
        return;
      }
      void api
        .prepareOrgPlanSupervision(ref, undefined, undefined, request.signal)
        .then((result) => {
          if (current === generation && !disposed) preparation = result;
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
    await refreshProfiles();
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
  async function refreshProfiles(): Promise<void> {
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
      if (
        current !== generation ||
        validation !== validationGeneration ||
        disposed ||
        !dialog?.open
      )
        return;
      if (fresh.kind === 'blocked') {
        report(fresh.reason, true);
        if (fresh.code === 'SKILL_PROFILE_UNAVAILABLE' && selected)
          confirmed = {
            ...snapshot,
            skillProfiles: snapshot.skillProfiles.filter((profile) => profile.name !== selected),
          };
      } else {
        confirmed = fresh;
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
        report(error instanceof Error ? error.message : 'Could not read skill profiles.', true);
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
  async function confirm(): Promise<void> {
    if (busy || blocked || !confirmed || !transport || !validSelection) return;
    const current = generation;
    const snapshot = confirmed;
    const validation = ++validationGeneration;
    validating = true;
    try {
      const result = await launcher.submit({
        reference: snapshot.reference,
        expectedRevision: snapshot.revision,
        skillProfile: selected,
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
        report(result.reason, true);
        return;
      }
      if (result.kind === 'partial') report(result.reason);
      if (dialog?.open) dialog.close();
      onresult?.(result);
    } catch (error) {
      if (!disposed && current === generation)
        report(error instanceof Error ? error.message : 'Could not start supervision.');
    } finally {
      if (!disposed && current === generation && validation === validationGeneration)
        validating = false;
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
      problem = '';
      void refreshProfiles();
    }}
  >
    <option value="">Default</option>
    {#if selected && !confirmed?.skillProfiles.some((profile) => profile.name === selected && !profile.error)}<option
        value={selected}
        disabled>{selected} (unavailable)</option
      >{/if}
    {#each confirmed?.skillProfiles.filter((profile) => !profile.error) ?? [] as profile (profile.name)}<option
        value={profile.name}>{profile.name}</option
      >{/each}
  </select>
  {#each confirmed?.warnings ?? [] as warning}<p class="guidance">{warning}</p>{/each}
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
    {#if problem}<AppControl disabled={busy} onclick={() => void refreshProfiles()}
        >Refresh</AppControl
      >{/if}
    <AppControl primary disabled={busy || blocked || !validSelection} onclick={() => void confirm()}
      >{submitting ? 'Starting…' : 'OK'}</AppControl
    >
  </div>
</dialog>

<style>
  .execute-action {
    display: grid;
    gap: 0.3rem;
    min-inline-size: 0;
  }
  .reason {
    color: var(--theme-text-muted);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
    max-inline-size: 28rem;
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
</style>
