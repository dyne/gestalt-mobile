<script lang="ts">
  import { submitsOnEnter } from './keyboard.js';
  type Props = { message: string; activeTurnId: string | null; starting: boolean; onchange(value: string): void; onsend(): void; oninterrupt(): void };
  let { message, activeTurnId, starting, onchange, onsend, oninterrupt }: Props = $props();
  function keydown(event: KeyboardEvent): void {
    if (!submitsOnEnter(event) || activeTurnId || starting || !message.trim()) return;
    event.preventDefault(); onsend();
  }
</script>
<form onsubmit={(event) => { event.preventDefault(); onsend(); }}>
  <label for="message">Message</label>
  <textarea id="message" value={message} oninput={(event) => onchange(event.currentTarget.value)} onkeydown={keydown} rows="3" required></textarea>
  <button type="submit" disabled={Boolean(activeTurnId) || starting || !message.trim()}>Send</button>
  {#if activeTurnId}<button type="button" onclick={oninterrupt}>Interrupt</button>{/if}
</form>
