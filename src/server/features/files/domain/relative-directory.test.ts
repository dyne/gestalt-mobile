/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { parseRelativeDirectory } from './relative-directory.js';

describe('relative directories', () => {
  it('accepts root, nested Unicode paths, and dotfiles other than .git', () => {
    expect(parseRelativeDirectory('')).not.toBeNull();
    expect(parseRelativeDirectory('文書/.config')).not.toBeNull();
  });
  it.each(['/x', '../x', 'a/../b', 'a//b', 'a\\b', 'a\0b', '.', '.git', 'a/.git/b'])(
    'rejects %s',
    (value) => expect(parseRelativeDirectory(value)).toBeNull(),
  );
});
