/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** CSS custom properties every named skin must provide. */
export const requiredThemeTokens = [
  '--theme-page',
  '--theme-canvas',
  '--theme-surface',
  '--theme-surface-subtle',
  '--theme-text',
  '--theme-text-muted',
  '--theme-border',
  '--theme-focus',
  '--theme-accent',
  '--theme-accent-contrast',
  '--theme-control-hover',
  '--theme-control-pressed',
  '--theme-control-pressed-contrast',
  '--theme-control-disabled',
  '--theme-success',
  '--theme-warning',
  '--theme-error',
  '--theme-info',
  '--theme-code',
  '--theme-shadow',
  '--theme-radius',
  '--theme-font-body',
  '--theme-font-display',
  '--theme-font-code',
  '--theme-motion-fast',
] as const;
