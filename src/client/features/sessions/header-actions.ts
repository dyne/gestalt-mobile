/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySession } from './relay-client.js';
import type { Tab } from './tab-state.js';

export type HeaderAction = { id: string; label: string; run(): void };
export type ContextualHeaderAction = HeaderAction & {
  tab: Tab;
  available(session: RelaySession): boolean;
};

export function visibleHeaderActions(
  actions: readonly ContextualHeaderAction[],
  tab: Tab,
  session: RelaySession | null,
): HeaderAction[] {
  return session ? actions.filter((action) => action.tab === tab && action.available(session)) : [];
}
