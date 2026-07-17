/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const eventRetention = 2000;
export function retainedSequences(sequences: number[]): number[] {
  return sequences.slice(-eventRetention);
}
