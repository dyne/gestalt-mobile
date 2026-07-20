/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const documentation = await readFile('docs/releasing.md', 'utf8');

describe('release operations documentation', () => {
  it.each([
    'Protect `main`',
    '`Verify` and `Package smoke`',
    'npm trusted publishing',
    'workflow filename to `ci.yml`',
    'Do not configure an npm token',
    '`id-token: write`',
    'Partial-release recovery',
    'git push --tags',
    'git push origin "refs/tags/v$VERSION"',
    'v0.1.0',
  ])('documents %s', (requirement) => {
    expect(documentation).toContain(requirement);
  });

  it('warns maintainers not to push inherited tags', () => {
    expect(documentation).toContain('Never run `git push --tags`');
    expect(documentation).toContain('unrelated `v1.x` tags');
  });

  it('documents revocation without long-lived npm credentials', () => {
    expect(documentation).toContain('remove or replace that trusted publisher');
    expect(documentation).not.toContain('NPM_TOKEN');
  });
});
