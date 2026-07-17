<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { submitsOnEnter } from './keyboard.js';
  type Props = { status: string; message: string; activeTurnId: string | null; starting: boolean; onchange(value: string): void; onsend(): void; oninterrupt(): void };
  let { status, message, activeTurnId, starting, onchange, onsend, oninterrupt }: Props = $props();
  function keydown(event: KeyboardEvent): void {
    if (!submitsOnEnter(event) || activeTurnId || starting || !message.trim()) return;
    event.preventDefault(); onsend();
  }
</script>
<form onsubmit={(event) => { event.preventDefault(); onsend(); }}>
  <p role="status">{status}</p>
  <div class="prompt-row">
    <textarea id="message" aria-label="Prompt" placeholder="Prompt" value={message} oninput={(event) => onchange(event.currentTarget.value)} onkeydown={keydown} rows="1" required></textarea>
    <button type="submit" aria-label="Send prompt" disabled={Boolean(activeTurnId) || starting || !message.trim()}><span aria-hidden="true">↑</span></button>
  </div>
  {#if activeTurnId}<button type="button" onclick={oninterrupt}>Interrupt</button>{/if}
</form>

<style>
  form > [role='status'] { margin-block: 0 0.35rem; text-align: end; }
  .prompt-row { display: flex; align-items: end; gap: 0.5rem; }
  textarea { flex: 1 1 auto; min-block-size: 2.75rem; resize: vertical; }
  .prompt-row button { flex: 0 0 auto; inline-size: 2.75rem; min-block-size: 2.75rem; padding: 0; font-size: 1.4rem; }
</style>
