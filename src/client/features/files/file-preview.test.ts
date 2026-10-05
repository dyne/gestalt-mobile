/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  formatFile,
  markdownPreview,
  planFileReference,
  relativeFileReference,
} from './file-preview.js';

describe('file preview formatting and reference paths', () => {
  it('pretty prints JSON and retains malformed JSON as readable text', () => {
    expect(
      formatFile({ kind: 'file', path: 'data.json', content: '{"count":2}', size: 11 }),
    ).toEqual({ format: 'json', text: '{\n  "count": 2\n}' });
    expect(formatFile({ kind: 'file', path: 'data.json', content: '{oops', size: 5 })).toEqual({
      format: 'text',
      text: '{oops',
    });
  });
  it('renders Markdown structure while removing scripts, event handlers and remote images', () => {
    const html = markdownPreview(
      '# Title\n\n- One\n- **Two**\n\n[unsafe](javascript:alert(1))\n<script>alert(1)</script>\n<img src="https://remote/image" onerror="alert(1)">',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>Two</strong>');
    expect(html).not.toMatch(/<script|<img|onerror|href="javascript:/);
  });
  it('resolves project references from the catalog and relative Markdown links from their file', () => {
    expect(planFileReference('group/project/.gestalt/plans/a.org', 'docs/hello.md')).toBe(
      'group/project/docs/hello.md',
    );
    expect(planFileReference('.gestalt/a.org', '/absolute/path')).toBe('/absolute/path');
    expect(relativeFileReference('project/docs/readme.md', '../config.json')).toBe(
      'project/docs/../config.json',
    );
  });
});
