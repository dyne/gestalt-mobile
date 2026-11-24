<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script lang="ts">
  import { onDestroy } from 'svelte';
  let tip: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held: HTMLButtonElement | null = null;
  let origin: { x: number; y: number } | null = null;

  function cancelTimer() {
    clearTimeout(timer);
    origin = null;
  }
  onDestroy(hide);

  function hide() {
    cancelTimer();
    tip?.remove();
    tip = null;
  }
  function iconButton(target: EventTarget | null) {
    const button = target instanceof Element ? target.closest('button[title]') : null;
    return button instanceof HTMLButtonElement && button.querySelector('.ui-icon') ? button : null;
  }
  function show(button: HTMLButtonElement) {
    if (!button.isConnected) return;
    tip?.remove();
    tip = document.createElement('div');
    tip.className = 'icon-tooltip';
    tip.setAttribute('aria-hidden', 'true');
    // Keep the hint inside its dialog or menu when the control is in the top layer.
    const surface = button.closest('dialog[open], [popover]:popover-open') ?? document.body;
    surface.append(tip);
    tip.textContent = button.title;

    const { left, width, top, bottom } = button.getBoundingClientRect();
    tip.style.left =
      Math.max(
        4,
        Math.min(
          left + (width - tip.offsetWidth) / 2,
          document.documentElement.clientWidth - tip.offsetWidth - 4,
        ),
      ) + 'px';
    tip.style.top = (top >= tip.offsetHeight + 6 ? top - tip.offsetHeight - 4 : bottom + 4) + 'px';
  }
  function keyboardFocus(event: FocusEvent) {
    const button = iconButton(event.target);
    if (!button) return;
    requestAnimationFrame(() => {
      if (document.activeElement === button && button.matches(':focus-visible')) show(button);
    });
  }

  function pointerDown(event: PointerEvent) {
    hide();
    held = null;
    const button = iconButton(event.target);
    if (event.pointerType !== 'touch' || !event.isPrimary || !button) return;
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      if (button.isConnected) {
        held = button;
        show(button);
      }
    }, 500);
  }
  function pointerMove(event: PointerEvent) {
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) hide();
  }
  function click(event: MouseEvent) {
    if (held && event.detail && held === iconButton(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    held = null;
    hide();
  }
</script>

<svelte:document
  onfocusin={keyboardFocus}
  onpointerdowncapture={pointerDown}
  onpointermovecapture={pointerMove}
  onpointerupcapture={cancelTimer}
  onpointercancelcapture={hide}
  oncontextmenu={(event) => {
    if ((origin || held) && iconButton(event.target)) event.preventDefault();
  }}
  onclickcapture={click}
  onfocusout={hide}
  onkeydown={(event) => {
    if (event.key === 'Escape') hide();
  }}
  onscrollcapture={hide}
/>
<svelte:window onresize={hide} />

<style>
  :global(.icon-tooltip) {
    z-index: 1000;
    position: fixed;
    inset: auto;
    margin: 0;
    max-inline-size: min(20rem, calc(100vw - 8px));
    overflow-wrap: anywhere;
    padding: 0.35rem 0.55rem;
    border: 0;
    border-radius: var(--theme-radius);
    background: var(--theme-text);
    color: var(--theme-surface);
    font: 500 0.8125rem / 1.35 var(--theme-font-body);
    pointer-events: none;
  }
</style>
