<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script module lang="ts">
  const paths = {
    open: 'M12 4h7a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7 M3 12h12 m-5-5 5 5-5 5',
    external: 'M14 4h6v6 M20 4l-9 9 M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4',
    cli: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M7 9l3 3-3 3 M13 15h4',
    copy: 'M10 9h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z M15 6V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1',
    close: 'M6 6l12 12 M18 6 6 18',
    plan: 'm3 7 2 2 3-4 M12 7h9 M3 15l2 2 3-4 M12 15h9',
    autopilot: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z m4 5-2.5 5.5L8 16l2.5-5.5Z',
    download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v4h16v-4',
    refresh: 'M20 4v6h-6 M20 10a8 8 0 1 0-.6 6',
    menu: 'M3 6h18 M3 12h18 M3 18h18',
    bell: 'M5 17h14l-2-4v-3a5 5 0 0 0-10 0v3Z M10 20a2.5 2.5 0 0 0 4 0',
    note: 'M5 3h14v12l-6 6H5Z M13 21v-6h6 M8 8h8 M8 12h5',
    devices: 'M12 17H3V4h17v4 M7 20h5 M15 10h6v11h-6Z',
    lock: 'M5 10h14v11H5Z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
    debug:
      'M8 8h8v7a4 4 0 0 1-8 0Z M10 8V6a2 2 0 0 1 4 0v2 M8 11l-4-2 M16 11l4-2 M8 14H3 M16 14h5 M8 17l-4 3 M16 17l4 3',
    clean: 'M3 6h18 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
    upgrade: 'M12 16V4 m-5 5 5-5 5 5 M4 16v4h16v-4',
    power: 'M12 2v10 M7 5a8 8 0 1 0 10 0',
    sessions: 'M3 7h7l2 2h9v10H3z M5 4h6l2 2h6',
    chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2z M7 9h10 M7 13h6',
    git: 'M8 8v8 M10 15c5 0 7-2 7-5 M8 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M8 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M17 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    waiting: 'M6 3h12 M6 21h12 M7 3v4l10 10v4 M17 3v4L7 17v4',
  };
  export type IconName = keyof typeof paths;
</script>

<script lang="ts">
  let { name, size = '1.2rem' }: { name: IconName; size?: string } = $props();
</script>

<svg
  class="ui-icon"
  aria-hidden="true"
  focusable="false"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d={paths[name]} />
</svg>

<style>
  svg {
    display: inline-block;
    vertical-align: middle;
    flex: none;
  }
</style>
