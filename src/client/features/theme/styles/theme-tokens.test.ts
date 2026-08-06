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

function token(css: string, name: string): string {
  const value = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];
  if (!value) throw new Error(`Missing hexadecimal color token ${name}`);
  return value;
}

function luminance(color: string): number {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe('theme token contract', () => {
  it.each(themes)('defines every semantic token and color scheme for $id', (theme) => {
    const css = [
      readFileSync(new URL('foundations.css', styles), 'utf8'),
      readFileSync(new URL(`${theme.id}.css`, styles), 'utf8'),
    ].join('\n');
    expect(css).toContain(`color-scheme: ${theme.colorScheme}`);
    for (const token of requiredThemeTokens) expect(css).toContain(`${token}:`);
  });

  it.each(themes)('keeps interactive text pairs readable for $id', (theme) => {
    const css = readFileSync(new URL(`${theme.id}.css`, styles), 'utf8');
    for (const [background, foreground] of [
      ['--theme-accent', '--theme-accent-contrast'],
      ['--theme-control-pressed', '--theme-control-pressed-contrast'],
    ] as const) {
      expect(
        contrast(token(css, background), token(css, foreground)),
        `${theme.id} ${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
