/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mount } from 'svelte';

import App from './App.svelte';
import { consumeEnrollmentFragment } from './features/auth/enrollment-fragment.js';

export function mountClient(
  target: Element,
  location: Location,
  history: History,
  mountApp: typeof mount = mount,
): ReturnType<typeof mount> {
  // The app starts its auth-status fetch during mount, so remove the capability before that can run.
  const enrollmentTicket = consumeEnrollmentFragment(location, history);
  return mountApp(App, { target, props: { enrollmentTicket } });
}
