/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mount } from 'svelte';

import App from './App.svelte';
import { consumeEnrollmentFragment } from './features/auth/enrollment-fragment.js';
import { bootstrapTheme, type ThemeBrowserDependencies } from './features/theme/browser-theme.js';

export function mountClient(
  target: Element,
  location: Location,
  history: History,
  mountApp: typeof mount = mount,
  themeDependencies: ThemeBrowserDependencies = {},
): ReturnType<typeof mount> {
  // The app starts its auth-status fetch during mount, so remove the capability before that can run.
  const enrollmentTicket = consumeEnrollmentFragment(location, history);
  const initialTheme = bootstrapTheme(themeDependencies);
  return mountApp(App, { target, props: { enrollmentTicket, initialTheme } });
}
