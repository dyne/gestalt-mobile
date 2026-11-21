/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function cleanupFolderPreview(details: readonly string[], total = details.length): string {
  const preview = details.slice(0, 3);
  const remaining = total - preview.length;
  const more = remaining > 0 ? ` and ${remaining} other folder${remaining === 1 ? '' : 's'}` : '';
  return `${preview.join(', ')}${more}`;
}
