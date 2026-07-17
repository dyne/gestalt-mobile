/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { copyText } from './clipboard.js';
describe('copyText', () => {
  it('reports clipboard failure without throwing', async () =>
    expect(
      copyText('x', {
        writeText: async () => {
          throw new Error('denied');
        },
      }),
    ).resolves.toBe(false));

  it('uses the legacy copy path when Clipboard API is unavailable', async () =>
    expect(copyText('x', undefined, () => true)).resolves.toBe(true));

  it('contains a legacy copy failure', async () =>
    expect(
      copyText('x', undefined, () => {
        throw new Error('blocked');
      }),
    ).resolves.toBe(false));
});
