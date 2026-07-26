/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { packedFilename } from './npm-pack-report.mjs';

describe('packedFilename', () => {
  it('reads the legacy npm array report', () => {
    expect(
      packedFilename(
        [{ name: 'gestalt-mobile', filename: 'gestalt-mobile-0.1.0.tgz' }],
        'gestalt-mobile',
      ),
    ).toBe('gestalt-mobile-0.1.0.tgz');
  });

  it('reads the npm 12 package-name-keyed report', () => {
    expect(
      packedFilename(
        {
          'gestalt-mobile': {
            name: 'gestalt-mobile',
            filename: 'gestalt-mobile-0.1.0.tgz',
          },
        },
        'gestalt-mobile',
      ),
    ).toBe('gestalt-mobile-0.1.0.tgz');
  });

  it('rejects a report without a package filename', () => {
    expect(() => packedFilename({}, 'gestalt-mobile')).toThrow(
      'npm pack report did not contain a filename for gestalt-mobile',
    );
  });
});
