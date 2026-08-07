<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';

  import RelayApp from './RelayApp.svelte';
  import { createAuthClient } from './features/auth/auth-client.js';
  import { createAuthorizedFetch } from './features/auth/authorized-fetch.js';
  import FirstDeviceEnrollment from './features/auth/FirstDeviceEnrollment.svelte';
  import PasskeyLogin from './features/auth/PasskeyLogin.svelte';
  import { createAuthStateMachine, type AuthState } from './features/auth/auth-state.js';
  import { type ThemeId } from './features/theme/theme-registry.js';

  let {
    enrollmentTicket: initialEnrollmentTicket,
    initialTheme = 'dyne-org',
  }: { enrollmentTicket?: string; initialTheme?: ThemeId } = $props();
  let localEnrollmentTicket = $state<string | undefined>(undefined);
  let enrollmentTicket = $derived(localEnrollmentTicket ?? initialEnrollmentTicket);
  let authState = $state<AuthState>({ kind: 'checking' });
  let locking = false;
  const client = createAuthClient();
  const machine = createAuthStateMachine(client, (next) => (authState = next));
  const authorizedFetch = createAuthorizedFetch(() =>
    machine.locked('Your session ended. Sign in with your passkey to continue.'),
  );

  onMount(() => {
    void machine.check(enrollmentTicket);
  });

  function createPasskeyHere(ticket: string): void {
    localEnrollmentTicket = ticket;
    authState = {
      kind: 'enrollment',
      publicOrigin: authState.kind === 'authenticated' ? '' : 'http://localhost',
    };
  }

  async function lockRelay(): Promise<void> {
    if (locking || authState.kind !== 'authenticated') return;
    locking = true;
    machine.locked('Relay locked. Sign in with your passkey to continue.');
    try {
      await client.logout();
    } catch {
      machine.locked('Relay locked locally. Recheck your connection before signing in again.');
    } finally {
      locking = false;
    }
  }
</script>

{#if authState.kind === 'authenticated'}
  <RelayApp
    {authorizedFetch}
    theme={initialTheme}
    passkeyAuthEnabled={authState.passkeyAuthEnabled}
    onlock={() => void lockRelay()}
    oncreatepasskey={createPasskeyHere}
  />
{:else if authState.kind === 'bootstrap' || authState.kind === 'enrollment'}
  <FirstDeviceEnrollment
    {client}
    canonicalOrigin={authState.publicOrigin}
    {enrollmentTicket}
    onAuthenticated={() => machine.authenticated()}
    onLocked={(message) => machine.locked(message)}
  />
{:else if authState.kind === 'locked'}
  <PasskeyLogin
    {client}
    message={authState.message}
    onAuthenticated={() => machine.authenticated()}
  />
{:else}
  <main class="auth-gate" aria-live="polite">
    {#if authState.kind === 'checking'}
      <p>Checking this device…</p>
    {:else if authState.kind === 'unsupported'}
      <h1>Passkey support is required</h1>
      <p>{authState.message}</p>
    {:else if authState.kind === 'error'}
      <h1>Unable to check this device</h1>
      <p>{authState.message}</p>
      <button type="button" onclick={() => void machine.retry()}>Try again</button>
    {/if}
  </main>
{/if}

<style>
  .auth-gate {
    max-width: 32rem;
    margin: 12vh auto;
    padding: 2rem;
    color: var(--theme-text);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: var(--theme-radius);
    box-shadow: 0 0.5rem 1.5rem var(--theme-shadow);
  }
  .auth-gate h1 {
    font-family: var(--theme-font-display);
  }
  button {
    margin-right: 0.75rem;
  }
</style>
