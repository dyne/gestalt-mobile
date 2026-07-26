/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type Tab = 'chat' | 'git' | 'sessions' | 'skills';
export function nextTab(current: Tab, direction: 1 | -1, chatEnabled = true): Tab {
  const tabs: Tab[] = chatEnabled
    ? ['sessions', 'git', 'skills', 'chat']
    : ['sessions', 'git', 'skills'];
  return tabs[(tabs.indexOf(current) + direction + tabs.length) % tabs.length]!;
}
