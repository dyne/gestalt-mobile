/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Return the tarball filename from either the legacy npm pack array report or
 * npm 12's package-name-keyed report.
 */
export function packedFilename(report, packageName) {
  const entry = Array.isArray(report)
    ? (report.find((candidate) => candidate?.name === packageName) ?? report[0])
    : report?.[packageName];

  if (!entry || typeof entry.filename !== 'string' || entry.filename.length === 0) {
    throw new TypeError(`npm pack report did not contain a filename for ${packageName}`);
  }
  return entry.filename;
}
