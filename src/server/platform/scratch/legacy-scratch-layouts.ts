/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Historical producer names are discovery hints only. None establish ownership
 * or release; these candidates are retained. See docs/legacy-scratch-provenance.md.
 */
const legacyPrefixes = [
  '.ctx-mode-',
  'gestalt-cli-playwright-',
  'gestalt-xerj-regression-',
  'gestalt-sandbox-doctor-',
  'gestalt-serena-doctor-',
  'gestalt-chrome.',
  'gestalt-skills-export.',
  'gestalt-skills-import.',
  'gestalt-update.',
] as const;

export function isAmbiguousLegacyScratch(name: string): boolean {
  return legacyPrefixes.some((prefix) => name.startsWith(prefix) && name.length > prefix.length);
}
