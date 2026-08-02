<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->
<svelte:options runes={true} />
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { enrollmentQrDataUrl } from './qr-link.js';
  import type { DeviceClient, EnrollmentTicket, ManagedDevice, TicketStatus } from './device-client.js';

  type Props = { client: DeviceClient; onclose: () => void; onlock: () => void; oncreatepasskey?: (ticket: string) => void };
  let { client, onclose, onlock, oncreatepasskey = () => {} }: Props = $props();
  let devices = $state<ManagedDevice[]>([]);
  let error = $state('');
  let ticket = $state<EnrollmentTicket | null>(null);
  let ticketStatus = $state<TicketStatus>('none');
  let qr = $state<string | null>(null);
  let revokeDialog = $state<HTMLDialogElement | null>(null);
  let selected = $state<ManagedDevice | null>(null);
  let polling = $state<ReturnType<typeof setInterval> | null>(null);
  let now = $state(Date.now());
  const sorted = $derived([...devices].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  const secondsRemaining = $derived(ticket ? Math.max(0, Math.ceil((Date.parse(ticket.expiresAt) - now) / 1000)) : 0);
  const formattedRemaining = $derived(`${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, '0')}`);

  function validNickname(value: string): boolean { const trimmed = value.trim(); return [...trimmed].length >= 1 && [...trimmed].length <= 64; }
  function stopPolling(): void { if (polling) clearInterval(polling); polling = null; }
  function startPolling(): void { stopPolling(); polling = setInterval(() => void poll(), 15_000); }
  function activeTicket(): boolean { return Boolean(ticket && ticketStatus === 'pending' && secondsRemaining > 0 && document.visibilityState === 'visible'); }
  async function load(): Promise<void> { try { devices = (await client.list()).devices; } catch { error = 'Could not refresh authorized devices. Try again.'; } }
  async function poll(): Promise<void> {
    if (!activeTicket()) { if (secondsRemaining === 0 && ticket) ticketStatus = 'expired'; stopPolling(); return; }
    try {
      ticketStatus = (await client.ticketStatus()).status;
      if (ticketStatus !== 'pending') { stopPolling(); if (ticketStatus === 'used') await load(); }
    } catch { stopPolling(); }
  }
  async function createTicket(): Promise<void> {
    error = '';
    try { ticket = await client.createTicket(); ticketStatus = 'pending'; qr = await enrollmentQrDataUrl(ticket.url); now = Date.now(); startPolling(); }
    catch { error = 'Could not create an enrollment link. Try again.'; }
  }
  async function cancelTicket(): Promise<void> {
    try { ticketStatus = (await client.cancelTicket()).status; ticket = null; qr = null; stopPolling(); }
    catch { error = 'Could not cancel the enrollment link. Try again.'; }
  }
  async function replaceTicket(): Promise<void> { await cancelTicket(); if (!error) await createTicket(); }
  async function rename(device: ManagedDevice, value: string): Promise<void> {
    if (!validNickname(value)) { error = 'Device nicknames must be 1–64 characters.'; return; }
    error = '';
    try { await client.rename(device.id, value.trim()); await load(); } catch { error = 'Could not rename this device. Try again.'; }
  }
  function requestRevoke(device: ManagedDevice): void { if (sorted.length > 1) { selected = device; revokeDialog?.showModal(); } }
  async function revoke(): Promise<void> {
    if (!selected) return;
    try { await client.revoke(selected.id); revokeDialog?.close(); if (selected.current) onlock(); else await load(); }
    catch { error = 'This device could not be revoked. Try again.'; }
  }
  async function copy(): Promise<void> { if (!ticket) return; try { await navigator.clipboard.writeText(ticket.url); } catch { error = 'Copy is unavailable here. Select the visible link instead.'; } }
  function visibilityChanged(): void { if (document.visibilityState === 'visible' && ticketStatus === 'pending' && secondsRemaining > 0) { void poll(); startPolling(); } else stopPolling(); }
  onMount(() => { void load(); document.addEventListener('visibilitychange', visibilityChanged); const clock = setInterval(() => now = Date.now(), 1_000); return () => clearInterval(clock); });
  onDestroy(() => { stopPolling(); document.removeEventListener('visibilitychange', visibilityChanged); });
</script>

<main class="devices" aria-labelledby="devices-title">
  <header><button type="button" onclick={onclose}>Back</button><h1 id="devices-title">Authorized devices</h1></header>
  {#if error}<p class="feedback" role="status">{error}</p>{/if}
  {#if sorted.length}
    <ul aria-label="Authorized devices">{#each sorted as device (device.id)}
      <li><form onsubmit={(event) => { event.preventDefault(); void rename(device, String(new FormData(event.currentTarget).get('nickname') ?? '')); }}>
        <label for={`nickname-${device.id}`}>Nickname</label><input id={`nickname-${device.id}`} name="nickname" value={device.nickname} aria-label={`Nickname for ${device.nickname}`} />
        <p>Added {new Date(device.createdAt).toLocaleDateString()}{#if device.lastUsedAt} · Last used {new Date(device.lastUsedAt).toLocaleDateString()}{/if}{#if device.current} · This device{/if}</p>
        <button type="submit">Rename</button>
        <button type="button" disabled={sorted.length === 1} aria-describedby={sorted.length === 1 ? `final-${device.id}` : undefined} onclick={() => requestRevoke(device)}>Revoke</button>
        {#if sorted.length === 1}<span id={`final-${device.id}`}>At least one authorized device is required.</span>{/if}
      </form></li>
    {/each}</ul>
  {:else}<p role="status">No authorized devices are available. Refresh this page before making changes.</p>{/if}
  <section aria-labelledby="add-title"><h2 id="add-title">Authorize another device</h2>
    {#if !ticket}<button type="button" onclick={() => void createTicket()}>Create enrollment link</button>
    {:else}
      <p role="status">{ticketStatus === 'pending' ? `Enrollment link is active for ${formattedRemaining}.` : `Enrollment link is ${ticketStatus}.`}</p>
      {#if qr}<img src={qr} alt="QR code for the enrollment link" />{/if}
      <label for="enrollment-link">Enrollment link</label><textarea id="enrollment-link" readonly rows="3">{ticket.url}</textarea>
      <div class="actions"><button type="button" onclick={() => void copy()}>Copy enrollment link</button><button type="button" onclick={() => oncreatepasskey(ticket!.ticket)}>Create passkey here</button><button type="button" onclick={() => void cancelTicket()}>Cancel link</button><button type="button" onclick={() => void replaceTicket()}>Replace link</button></div>
    {/if}
  </section>
</main>
<dialog bind:this={revokeDialog} aria-labelledby="revoke-title"><h2 id="revoke-title">Revoke authorized device?</h2><p>This immediately signs out sessions created by this passkey.</p><form method="dialog"><button type="submit">Keep device</button><button type="button" onclick={() => void revoke()}>Revoke device</button></form></dialog>
<style>
  .devices{max-inline-size:48rem;margin:auto;padding:1rem}.devices header{display:flex;gap:1rem;align-items:center}.devices ul{padding:0;list-style:none}.devices li,section{margin-block:1rem;padding:1rem;border:1px solid CanvasText;border-radius:.5rem}.devices form{display:grid;gap:.65rem}.devices p{margin:0;overflow-wrap:anywhere}.devices input,.devices textarea,.devices button{min-block-size:44px;font:inherit}.devices input,.devices textarea{min-inline-size:0;padding:.45rem}.devices textarea{inline-size:100%;box-sizing:border-box;overflow-wrap:anywhere;resize:vertical}.devices .actions{display:flex;gap:.5rem;flex-wrap:wrap}.devices .actions button{flex:1 1 11rem}.devices img{display:block;inline-size:12rem;max-inline-size:100%;margin-block:.75rem;background:white;padding:.5rem}.feedback{color:CanvasText;font-weight:700}dialog{max-inline-size:min(32rem,calc(100% - 2rem));color:CanvasText;background:Canvas;border:1px solid CanvasText;border-radius:.5rem}dialog form{display:flex;gap:.5rem;flex-wrap:wrap}@media(forced-colors:active){.devices li,section,dialog{border-color:CanvasText}}@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;animation-duration:.01ms!important}}
</style>
