/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type InteractionState = 'pending' | 'submitting' | 'resolved' | 'failed';
export function canSubmitInteraction(state: InteractionState): boolean {
  return state === 'pending' || state === 'failed';
}
