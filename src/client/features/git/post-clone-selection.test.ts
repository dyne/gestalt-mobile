/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import { selectAfterClone } from './post-clone-selection.js';

const node = (
  id: string,
  name: string,
  children: WorkspaceOption[] = [],
  isGitRepository = false,
): WorkspaceOption => ({ id, name, relativePath: name, isGitRepository, children });

describe('post-clone Git selection', () => {
  it('highlights and reveals a newly identifiable repository', () => {
    const previous = [node('root', '/', [node('destination', 'projects')])];
    const next = [
      node('root', '/', [
        node('destination', 'projects', [node('new-repository', 'gestalt-mobile', [], true)]),
      ]),
    ];

    expect(
      selectAfterClone(
        previous,
        next,
        'destination',
        'https://example.test/dyne/gestalt-mobile.git',
        new Set(),
      ),
    ).toEqual({
      selectedId: 'new-repository',
      expandedIds: new Set(['root', 'destination']),
    });
  });

  it('keeps and reveals the destination when a new repository is ambiguous', () => {
    const previous = [node('root', '/', [node('destination', 'projects')])];
    const next = [
      node('root', '/', [
        node('destination', 'projects', [
          node('new-a', 'alpha', [], true),
          node('new-b', 'beta', [], true),
        ]),
      ]),
    ];

    expect(
      selectAfterClone(previous, next, 'destination', 'ssh://example.test/unknown.git', new Set()),
    ).toEqual({ selectedId: 'destination', expandedIds: new Set(['root', 'destination']) });
  });
});
