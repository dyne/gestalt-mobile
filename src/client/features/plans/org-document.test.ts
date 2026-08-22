/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { parseOrgDocument } from './org-document.js';

describe('Org document projection', () => {
  it('retains metadata, plan state, descriptions, properties, and ordinary body text', () => {
    const document = parseOrgDocument(`#+TITLE: Roadmap
#+DATE: 2026-08-22

Introduction.
* WIP [#A] Deliver feature
:PROPERTIES:
:ID: deliver
:END:
- Goal :: Restore the useful plan view.
Notes for the executor.
** TODO Follow up
- Tests :: Exercise the browser.
`);

    expect(document.metadata).toEqual([
      ['TITLE', 'Roadmap'],
      ['DATE', '2026-08-22'],
    ]);
    expect(document.preamble).toEqual(['Introduction.']);
    expect(document.sections).toEqual([
      expect.objectContaining({
        level: 1,
        title: 'Deliver feature',
        state: 'WIP',
        priority: 'A',
        properties: [['ID', 'deliver']],
        descriptions: [['Goal', 'Restore the useful plan view.']],
        body: ['Notes for the executor.'],
      }),
      expect.objectContaining({
        level: 2,
        title: 'Follow up',
        state: 'TODO',
        descriptions: [['Tests', 'Exercise the browser.']],
      }),
    ]);
  });

  it('treats source text as data rather than HTML', () => {
    const document = parseOrgDocument('* Notes\n<script>alert(1)</script>');
    expect(document.sections[0]?.body).toEqual(['<script>alert(1)</script>']);
  });
});
