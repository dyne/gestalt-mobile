<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<svelte:options runes={true} />

<script lang="ts">
  import { startAuthentication } from '@simplewebauthn/browser';
  import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
  import { onMount } from 'svelte';

  import type { AuthClient } from './auth-client.js';
  import { webAuthnMessage } from './auth-state.js';

  type Props = { client: AuthClient; message?: string; onAuthenticated: () => void };
  let { client, message, onAuthenticated }: Props = $props();
  let feedback = $state('');
  let signingIn = $state(false);
  let signInButton = $state() as HTMLButtonElement;

  function supported(): boolean {
    return window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
  }

  function loginMessage(error: unknown): string {
    if (error instanceof Error && ['NotAllowedError', 'AbortError', 'SecurityError'].includes(error.name))
      return webAuthnMessage(error);
    return 'We could not complete sign-in. Please try again.';
  }

  onMount(() => {
    feedback = message ?? 'Use a passkey from an authorized device to unlock this relay.';
    signInButton?.focus();
  });

  async function signIn(): Promise<void> {
    if (signingIn || !supported()) return;
    signingIn = true;
    feedback = '';
    try {
      const { options } = await client.loginOptions();
      const response = await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
      await client.verifyLogin(response);
      onAuthenticated();
    } catch (error) {
      feedback = loginMessage(error);
    } finally {
      signingIn = false;
    }
  }
</script>

<main class="login" aria-live="polite">
  <section class="card" aria-labelledby="login-title">
    <p class="brand">Gestalt / Dyne</p>
    <h1 id="login-title">Unlock relay</h1>
    {#if !window.isSecureContext}
      <p class="error">Passkeys require this relay to be opened over a secure connection.</p>
    {:else if typeof window.PublicKeyCredential === 'undefined'}
      <p class="error">This browser does not support passkeys. Use an authorized browser or device.</p>
    {:else}
      <p>{feedback}</p>
      <button class="sign-in" type="button" bind:this={signInButton} disabled={signingIn} onclick={() => void signIn()}>
        {signingIn ? 'Waiting for passkey…' : 'Sign in with a passkey'}
      </button>
    {/if}
  </section>
</main>

<style>
  .login { box-sizing: border-box; inline-size: 100%; max-inline-size: none; min-height: 100dvh; margin: 0; padding: 1rem; display: grid; place-items: center; background: var(--theme-page); color: var(--theme-text); }
  .card { width: min(100%, 32rem); box-sizing: border-box; padding: clamp(1.25rem, 5vw, 3rem); background: var(--theme-surface); border: 1px solid var(--theme-border); border-radius: calc(var(--theme-radius) * 2); box-shadow: 0 0.5rem 1.5rem var(--theme-shadow); }
  .brand { color: var(--theme-info); font-family: var(--theme-font-display); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h1 { margin-block: .25rem 1rem; font-family: var(--theme-font-display); font-size: clamp(1.8rem, 7vw, 3rem); }
  .sign-in { min-height: 44px; width: 100%; margin-top: 1rem; padding: .55rem 1rem; border-radius: var(--theme-radius); background: var(--theme-accent); color: var(--theme-accent-contrast); border-color: var(--theme-accent); font: inherit; font-weight: 700; }
  .error { color: var(--theme-error); font-weight: 700; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; } }
</style>
