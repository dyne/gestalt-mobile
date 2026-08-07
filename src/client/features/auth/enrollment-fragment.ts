/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
export function consumeEnrollmentFragment(
  location: Location,
  history: History,
): string | undefined {
  const fragment = location.hash;
  if (!fragment.startsWith('#enroll=')) return undefined;
  const match = /^#enroll=([^&]+)$/.exec(fragment);
  history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  if (!match || !match[1]) return undefined;
  try {
    return decodeURIComponent(match[1]) || undefined;
  } catch {
    return undefined;
  }
}
