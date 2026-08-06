/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { themes } from '../theme-registry.js';
import { requiredThemeTokens } from './contract.js';

const styles = new URL('.', import.meta.url);

describe('theme token contract', () => {
  it.each(themes)('defines every semantic token and color scheme for $id', (theme) => {
    const css = [
      readFileSync(new URL('foundations.css', styles), 'utf8'),
      readFileSync(new URL(`${theme.id}.css`, styles), 'utf8'),
    ].join('\n');
    expect(css).toContain(`color-scheme: ${theme.colorScheme}`);
    for (const token of requiredThemeTokens) expect(css).toContain(`${token}:`);
  });
});
