/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type Tab = 'chat' | 'git' | 'sessions' | 'plan';
export type TabCapabilities = Readonly<{ chatEnabled: boolean; planEnabled?: boolean }>;
export function visibleTabs({ chatEnabled }: TabCapabilities): Tab[] {
  return ['sessions', 'git', ...(chatEnabled ? ['chat'] as Tab[] : []), 'plan'];
}
export function nextTab(current: Tab, direction: 1 | -1, capabilities: TabCapabilities = { chatEnabled: true }): Tab {
  const tabs = visibleTabs(capabilities);
  return tabs[(tabs.indexOf(current) + direction + tabs.length) % tabs.length]!;
}
