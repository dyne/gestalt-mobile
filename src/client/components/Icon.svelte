<!--
Copyright (C) 2026 Dyne.org foundation
Designed by Denis Roio <jaromil@dyne.org>
SPDX-License-Identifier: AGPL-3.0-or-later
-->

<script module lang="ts">
  export type IconName =
    | 'open'
    | 'external'
    | 'cli'
    | 'copy'
    | 'close'
    | 'plan'
    | 'autopilot'
    | 'download'
    | 'refresh'
    | 'menu'
    | 'bell'
    | 'note'
    | 'devices'
    | 'lock'
    | 'debug'
    | 'clean'
    | 'upgrade'
    | 'power'
    | 'sessions'
    | 'chat'
    | 'git'
    | 'document'
    | 'rename'
    | 'chevron'
    | 'folder-add'
    | 'move'
    | 'waiting'
    | 'more'
    | 'upload'
    | 'send';
</script>

<script lang="ts">
  import spriteUrl from './ui-icons.svg?url';

  let { name, size }: { name: IconName; size?: string } = $props();
</script>

<svg class="ui-icon" aria-hidden="true" focusable="false" style:--icon-size={size}>
  <use href={`${spriteUrl}#${name}`} />
</svg>

<style>
  svg {
    display: inline-block;
    vertical-align: middle;
    flex: none;
    width: var(--icon-size, 1.2rem);
    height: var(--icon-size, 1.2rem);
    fill: none;
    stroke: currentColor;
    stroke-width: var(--icon-stroke-width, 1.75);
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
