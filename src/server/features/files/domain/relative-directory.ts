/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** A normalized, POSIX workspace-relative directory. The root is the empty string. */
export type RelativeDirectory = string & { readonly __relativeDirectory: unique symbol };

export function parseRelativeDirectory(value: string): RelativeDirectory | null {
  if (value === '') return value as RelativeDirectory;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.endsWith('/'))
    return null;
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part === '.git'))
    return null;
  return value as RelativeDirectory;
}
