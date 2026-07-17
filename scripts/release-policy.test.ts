/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { conventionalNextVersion, decideBootstrap, decideTarget } from './release-policy.mjs';

const headSha = '0123456789abcdef0123456789abcdef01234567';

describe('release version policy', () => {
  it('bootstraps an empty origin and npm package at 0.1.0', () => {
    expect(
      decideBootstrap({ remoteTags: [], npmVersions: [], npmPublication: null, headSha }),
    ).toEqual({ mode: 'bootstrap', target: '0.1.0' });
  });

  it('uses normal semver after v0.1.0 exists', () => {
    expect(
      decideBootstrap({
        remoteTags: ['v0.1.0'],
        npmVersions: ['0.1.0'],
        npmPublication: { version: '0.1.0', gitHead: headSha },
        headSha,
      }),
    ).toEqual({ mode: 'semver', target: null });
    expect(conventionalNextVersion('0.1.0', ['feat: add feature'])).toBe('0.2.0');
    expect(conventionalNextVersion('0.1.0', ['fix: repair bug'])).toBe('0.1.1');
    expect(conventionalNextVersion('0.1.0', ['feat!: break API'])).toBe('1.0.0');
  });

  it('does not release docs-only or empty commit sets', () => {
    expect(conventionalNextVersion('0.1.0', ['docs: clarify usage'])).toBeNull();
    expect(conventionalNextVersion('0.1.0', [])).toBeNull();
  });

  it('rejects unexpected tags and npm versions before bootstrap', () => {
    expect(
      decideBootstrap({ remoteTags: ['v1.21.0'], npmVersions: [], npmPublication: null, headSha }),
    ).toHaveProperty('error');
    expect(
      decideBootstrap({ remoteTags: [], npmVersions: ['1.0.0'], npmPublication: null, headSha }),
    ).toHaveProperty('error');
  });
});

describe('release mutation policy', () => {
  it('publishes and creates GitHub metadata for a new version', () => {
    expect(
      decideTarget({
        target: '0.1.0',
        headSha,
        npmPublication: null,
        tagSha: null,
        releaseSha: null,
      }),
    ).toEqual({ publish: true, tag: true, release: true, complete: false });
  });

  it('repairs a matching npm publication missing its tag and release', () => {
    expect(
      decideTarget({
        target: '0.1.0',
        headSha,
        npmPublication: { version: '0.1.0', gitHead: headSha },
        tagSha: null,
        releaseSha: null,
      }),
    ).toEqual({ publish: false, tag: true, release: true, complete: false });
  });

  it('repairs only a missing GitHub Release', () => {
    expect(
      decideTarget({
        target: '0.1.0',
        headSha,
        npmPublication: { version: '0.1.0', gitHead: headSha },
        tagSha: headSha,
        releaseSha: null,
      }),
    ).toEqual({ publish: false, tag: false, release: true, complete: false });
  });

  it('recognizes a matching completed release without mutations', () => {
    expect(
      decideTarget({
        target: '0.1.0',
        headSha,
        npmPublication: { version: '0.1.0', gitHead: headSha },
        tagSha: headSha,
        releaseSha: headSha,
      }),
    ).toEqual({ publish: false, tag: false, release: false, complete: true });
  });

  it.each([
    {
      npmPublication: { version: '0.1.0', gitHead: 'different' },
      tagSha: null,
      releaseSha: null,
    },
    { npmPublication: null, tagSha: headSha, releaseSha: null },
    {
      npmPublication: { version: '0.1.0', gitHead: headSha },
      tagSha: 'different',
      releaseSha: null,
    },
  ])('fails closed for conflicting state %#', (state) => {
    expect(decideTarget({ target: '0.1.0', headSha, ...state })).toHaveProperty('error');
  });
});
