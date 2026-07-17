/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function mayStartTurn(state: string, text: string): boolean {
  return state === 'ready' && text.trim().length > 0;
}
