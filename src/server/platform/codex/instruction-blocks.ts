/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Replace only complete blocks owned by this capability, preserving all other bytes. */
export function withCapabilityInstructions(
  instructions: string,
  capability: 'xerj' | 'serena' | 'playwright',
  block: string,
): string {
  const pattern = new RegExp(
    `<gestalt_${capability}_(capability|unavailable)>[\\s\\S]*?</gestalt_${capability}_\\1>`,
    'gu',
  );
  let replaced = false;
  const result = instructions.replace(pattern, () => {
    if (replaced) return '';
    replaced = true;
    return block;
  });
  return replaced ? result : instructions + (instructions ? '\n' : '') + block;
}
