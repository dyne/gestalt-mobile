<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />

<script lang="ts">
  import { startRegistration } from '@simplewebauthn/browser';
  import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
  import { onDestroy, onMount } from 'svelte';

  import type { AuthClient } from './auth-client.js';
  import { bootstrapLink, bootstrapQrDataUrl } from './qr-link.js';
  import { webAuthnMessage } from './auth-state.js';

  type Props = {
    client: AuthClient;
    canonicalOrigin: string;
    onAuthenticated: () => void;
    onLocked: (message: string) => void;
    enrollmentTicket?: string;
  };

  let { client, canonicalOrigin, onAuthenticated, onLocked, enrollmentTicket }: Props = $props();
  let nickname = $state('');
  let feedback = $state<string | null>(null);
  let submitting = $state(false);
  let qrDataUrl = $state<string | null>(null);
  let enrollmentAvailable = true;
  let mounted = true;
  const link = $derived(bootstrapLink(canonicalOrigin));
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function supported(): boolean {
    return window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
  }

  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function enrollmentWonElsewhere(status: 'authenticated' | 'locked'): void {
    enrollmentAvailable = false;
    stopPolling();
    if (status === 'authenticated') {
      onAuthenticated();
      return;
    }
    onLocked('Another device has already enrolled this relay. Sign in with that device’s passkey.');
  }

  async function pollStatus(): Promise<void> {
    if (document.visibilityState !== 'visible') return;
    try {
      const status = await client.status();
      if (status.status !== 'bootstrap') {
        if (!mounted) return;
        enrollmentWonElsewhere(status.status);
      }
    } catch {
      // A transient public status failure does not discard the operator’s nickname.
    }
  }

  onMount(() => {
    if (!enrollmentTicket)
      void bootstrapQrDataUrl(canonicalOrigin)
        .then((value) => {
          if (mounted) qrDataUrl = value;
        })
        .catch(() => {
          if (mounted) feedback = 'Setup QR unavailable. Use the setup link below.';
        });
    const desktop = window.matchMedia?.('(min-width: 768px)').matches ?? false;
    if (desktop) pollTimer = setInterval(() => void pollStatus(), 15_000);
  });

  onDestroy(() => {
    mounted = false;
    enrollmentAvailable = false;
    stopPolling();
  });

  async function copyLink(): Promise<void> {
    if (!navigator.clipboard?.writeText) {
      feedback = 'Copy is unavailable here. Select and copy the visible setup link.';
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      feedback = 'Setup link copied.';
    } catch {
      feedback = 'Copy is unavailable here. Select and copy the visible setup link.';
    }
  }

  async function authorize(): Promise<void> {
    const trimmedNickname = nickname.trim();
    if (!trimmedNickname) {
      feedback = 'Enter a device nickname before authorizing it.';
      return;
    }
    if (!supported()) {
      feedback = 'Passkeys require a secure browser on this device.';
      return;
    }
    if (submitting || !enrollmentAvailable) return;
    submitting = true;
    feedback = null;
    try {
      const { options } = await client.registrationOptions(enrollmentTicket);
      if (!mounted || !enrollmentAvailable) return;
      const response = await startRegistration({
        optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
      });
      if (!mounted || !enrollmentAvailable) return;
      await client.verifyRegistration(response, trimmedNickname);
      if (!mounted || !enrollmentAvailable) return;
      stopPolling();
      onAuthenticated();
    } catch (error) {
      if (
        error instanceof Error &&
        ['AUTH_REQUEST_FAILED_409', 'BOOTSTRAP_ALREADY_CLAIMED'].includes(error.message)
      ) {
        stopPolling();
        onLocked('Another device completed setup first. Sign in with that device’s passkey.');
        return;
      }
      feedback = webAuthnMessage(error);
    } finally {
      submitting = false;
    }
  }
</script>

<main class="enrollment" aria-live="polite">
  <section class="card" aria-labelledby="enrollment-title">
    <p class="brand">Gestalt / Dyne</p>
    <h1 id="enrollment-title">
      {enrollmentTicket ? 'Authorize this device' : 'Authorize the first device'}
    </h1>
    {#if enrollmentTicket}
      <p class="warning">
        This one-time link authorizes one new passkey. Choose a nickname and complete the passkey
        prompt before it expires.
      </p>
    {:else}
      <p class="warning">
        <strong>Trust-on-first-use:</strong> anyone who can reach an empty relay instance could claim
        first-device access. Enroll this device before exposing the instance, and confirm you are at the
        canonical address before continuing.
      </p>
    {/if}
    <label for="device-nickname">Device nickname</label>
    <input
      id="device-nickname"
      name="device-nickname"
      autocomplete="nickname"
      bind:value={nickname}
      required
      enterkeyhint="done"
    />
    <button
      class="authorize"
      type="button"
      disabled={submitting || !supported()}
      onclick={() => void authorize()}
    >
      {submitting ? 'Authorizing device…' : 'Authorize this device'}
    </button>
    {#if !supported()}<p class="error">Passkeys require a secure browser on this device.</p>{/if}
    {#if feedback}<p class="feedback">{feedback}</p>{/if}
    {#if !enrollmentTicket}<div class="handoff">
        {#if qrDataUrl}<img src={qrDataUrl} alt="QR code for the first-device setup link" />{/if}
        <div>
          <h2>Continue on your phone</h2>
          <p>
            Scanning opens this same setup page. You will still choose a nickname and explicitly
            authorize that device.
          </p>
          <a href={link}>{link}</a>
          <button type="button" class="copy" onclick={() => void copyLink()}>Copy setup link</button
          >
        </div>
      </div>{/if}
  </section>
</main>

<style>
  .enrollment {
    box-sizing: border-box;
    inline-size: 100%;
    max-inline-size: none;
    min-height: 100dvh;
    margin: 0;
    padding: 1rem;
    display: grid;
    place-items: center;
    background: var(--theme-page);
    color: var(--theme-text);
  }
  .card {
    width: min(100%, 42rem);
    box-sizing: border-box;
    padding: clamp(1.25rem, 5vw, 3rem);
    background: var(--theme-surface);
    border: 1px solid var(--theme-border);
    border-radius: calc(var(--theme-radius) * 2);
    box-shadow: 0 0.5rem 1.5rem var(--theme-shadow);
  }
  .brand {
    color: var(--theme-info);
    font-family: var(--theme-font-display);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h1 {
    margin-block: 0.25rem 1rem;
    font-family: var(--theme-font-display);
    font-size: clamp(1.8rem, 7vw, 3rem);
  }
  .warning {
    padding: 1rem;
    border-left: 0.3rem solid var(--theme-warning);
    background: var(--theme-surface-subtle);
  }
  label,
  input {
    display: block;
    width: 100%;
    box-sizing: border-box;
  }
  label {
    margin-top: 1.5rem;
    font-weight: 700;
  }
  input,
  button {
    min-height: 44px;
    font: inherit;
  }
  input {
    margin-top: 0.4rem;
    padding: 0.6rem;
  }
  button {
    margin-top: 1rem;
    padding: 0.55rem 1rem;
    border-radius: 0.4rem;
    cursor: pointer;
  }
  .authorize {
    width: 100%;
    background: var(--theme-accent);
    color: var(--theme-accent-contrast);
    border-color: var(--theme-accent);
    font-weight: 700;
  }
  .feedback {
    color: var(--theme-info);
    font-weight: 700;
  }
  .error {
    color: var(--theme-error);
    font-weight: 700;
  }
  .handoff {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1rem;
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--theme-border);
  }
  .handoff img {
    width: 12rem;
    max-width: 100%;
    background: var(--theme-canvas);
    padding: 0.5rem;
  }
  a {
    color: var(--theme-info);
    overflow-wrap: anywhere;
  }
  .copy {
    display: block;
  }
  @media (min-width: 48rem) {
    .handoff {
      grid-template-columns: 12rem minmax(0, 1fr);
      align-items: start;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }
</style>
