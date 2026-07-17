/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { insertSourceHeader, sourceHeader, validateSourceHeader } from './license-headers.mjs';

describe('source license headers', () => {
  it.each([
    ['source.ts', '/*'],
    ['source.css', '/*'],
    ['component.svelte', '<!--'],
    ['index.html', '<!--'],
    ['command.sh', '# Copyright'],
    ['workflow.yml', '# Copyright'],
  ])('uses the appropriate comment syntax for %s', (path, prefix) => {
    expect(sourceHeader(path)).toMatch(new RegExp(`^${prefix.replace(/[/*]/g, '\\$&')}`));
  });

  it('preserves a shebang as the first line', () => {
    const updated = insertSourceHeader('command.mjs', '#!/usr/bin/env node\nconsole.log("ok");\n');
    expect(updated.startsWith('#!/usr/bin/env node\n\n/*')).toBe(true);
    expect(validateSourceHeader('command.mjs', updated)).toEqual([]);
  });

  it('inserts a TypeScript header idempotently before an upstream notice', () => {
    const path = 'src/server/platform/codex/upstream-example.ts';
    const upstream = '// Supplied by upstream.\nexport type Example = {};\n';
    const once = insertSourceHeader(path, upstream);
    expect(insertSourceHeader(path, once)).toBe(once);
    expect(once.indexOf('SPDX-License-Identifier')).toBeLessThan(
      once.indexOf('Supplied by upstream'),
    );
  });

  it('reports missing, reordered, and duplicate headers', () => {
    const header = sourceHeader('source.ts')!;
    expect(validateSourceHeader('source.ts', 'export {};\n')).toContain(
      'missing or malformed header',
    );
    const reordered = header.replace(
      'Copyright (C) 2026 Dyne.org foundation\n * Designed by Denis Roio <jaromil@dyne.org>',
      'Designed by Denis Roio <jaromil@dyne.org>\n * Copyright (C) 2026 Dyne.org foundation',
    );
    expect(validateSourceHeader('source.ts', `${reordered}\nexport {};\n`)).toContain(
      'missing or malformed header',
    );
    expect(validateSourceHeader('source.ts', `${header}\n${header}\nexport {};\n`)).toContain(
      'duplicate header',
    );
  });
});
