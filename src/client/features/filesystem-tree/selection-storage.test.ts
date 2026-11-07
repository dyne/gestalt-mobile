/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import { readTreeSelection, rememberTreeSelection } from './selection-storage.js';

const roots: WorkspaceOption[] = [
  {
    id: 'root',
    name: 'workspace',
    relativePath: '.',
    isGitRepository: false,
    children: [
      {
        id: 'opaque:repository',
        name: 'repository',
        relativePath: 'repository',
        isGitRepository: true,
        children: [],
      },
    ],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('remembered filesystem selection', () => {
  it('remembers one shared location, including repositories and ordinary clone destinations', () => {
    rememberTreeSelection('opaque:repository');
    expect(readTreeSelection(roots, 'root')).toBe('opaque:repository');
    rememberTreeSelection('root');

    expect(readTreeSelection(roots)).toBe('root');
  });

  it('uses a valid default when no saved selection exists or the saved folder disappeared', () => {
    expect(readTreeSelection(roots, 'root')).toBe('root');
    rememberTreeSelection('deleted');
    expect(readTreeSelection(roots, 'root')).toBe('root');
    expect(readTreeSelection(roots, 'deleted')).toBeNull();
  });

  it('clears an absent selection', () => {
    rememberTreeSelection('opaque:repository');
    rememberTreeSelection(null);
    expect(readTreeSelection(roots)).toBeNull();
  });

  it('keeps working when browser storage reads or writes fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
    expect(() => rememberTreeSelection('opaque:repository')).not.toThrow();
    expect(readTreeSelection(roots, 'root')).toBe('root');
  });
});
