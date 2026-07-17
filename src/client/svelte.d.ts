/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare module '*.svelte' {
  import type { Component } from 'svelte';

  const component: Component;
  export default component;
}
