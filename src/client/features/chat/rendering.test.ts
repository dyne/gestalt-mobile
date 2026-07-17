/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { renderCommentary, renderPlainText } from './rendering.js';
describe('renderPlainText', () => {
  it('does not interpret model text as HTML', () =>
    expect(renderPlainText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>'));

  it('preserves newlines for the plain-text renderer', () =>
    expect(renderPlainText('one\ntwo')).toBe('one\ntwo'));
});

describe('renderCommentary', () => {
  it('recognizes safe links and fenced code without interpreting HTML', () => {
    expect(
      renderCommentary('Read [the docs](https://example.com).\n```ts\nconst x = 1;\n```'),
    ).toEqual([
      {
        kind: 'text',
        parts: [
          { kind: 'text', text: 'Read ' },
          { kind: 'link', text: 'the docs', href: 'https://example.com' },
          { kind: 'text', text: '.\n' },
        ],
      },
      { kind: 'code', text: 'const x = 1;\n' },
    ]);
  });

  it('recognizes absolute filesystem paths in Markdown links', () => {
    expect(
      renderCommentary(
        '[org plan](/home/jrml/devel/dyne/agent-plugins/plugins/org-plan/skills/org-plan/SKILL.md)',
      ),
    ).toEqual([
      {
        kind: 'text',
        parts: [
          {
            kind: 'link',
            text: 'org plan',
            href: '/home/jrml/devel/dyne/agent-plugins/plugins/org-plan/skills/org-plan/SKILL.md',
          },
        ],
      },
    ]);
  });

  it('recognizes Codex deep links in Markdown links', () => {
    expect(
      renderCommentary(
        '[View org-plan](codex://plugins/org-plan?marketplacePath=%2Ftmp%2Fmarketplace.json) · [Share org-plan](codex://plugins/org-plan?marketplacePath=%2Ftmp%2Fmarketplace.json&mode=share)',
      ),
    ).toEqual([
      {
        kind: 'text',
        parts: [
          {
            kind: 'link',
            text: 'View org-plan',
            href: 'codex://plugins/org-plan?marketplacePath=%2Ftmp%2Fmarketplace.json',
          },
          { kind: 'text', text: ' · ' },
          {
            kind: 'link',
            text: 'Share org-plan',
            href: 'codex://plugins/org-plan?marketplacePath=%2Ftmp%2Fmarketplace.json&mode=share',
          },
        ],
      },
    ]);
  });

  it('recognizes language-tagged fences and inline code', () => {
    expect(renderCommentary('Use `git status`.\n```bash\ngit status\n```')).toEqual([
      {
        kind: 'text',
        parts: [
          { kind: 'text', text: 'Use ' },
          { kind: 'code', text: 'git status' },
          { kind: 'text', text: '.\n' },
        ],
      },
      { kind: 'code', text: 'git status\n' },
    ]);
  });

  it('recognizes Markdown tables and preserves inline code in their cells', () => {
    expect(
      renderCommentary(
        'Installation | What it receives | Update mechanism\n|---|---|---|\n| `npx skills add` | Only `my-skill/` | `npx skills update my-skill` |\n| `codex plugin add` | Whole `my-plugin/` bundle | Marketplace upgrade and plugin reinstall |',
      ),
    ).toEqual([
      {
        kind: 'table',
        headers: [
          [{ kind: 'text', text: 'Installation' }],
          [{ kind: 'text', text: 'What it receives' }],
          [{ kind: 'text', text: 'Update mechanism' }],
        ],
        rows: [
          [
            [{ kind: 'code', text: 'npx skills add' }],
            [
              { kind: 'text', text: 'Only ' },
              { kind: 'code', text: 'my-skill/' },
            ],
            [{ kind: 'code', text: 'npx skills update my-skill' }],
          ],
          [
            [{ kind: 'code', text: 'codex plugin add' }],
            [
              { kind: 'text', text: 'Whole ' },
              { kind: 'code', text: 'my-plugin/' },
              { kind: 'text', text: ' bundle' },
            ],
            [{ kind: 'text', text: 'Marketplace upgrade and plugin reinstall' }],
          ],
        ],
      },
    ]);
  });
});
