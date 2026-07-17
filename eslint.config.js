/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/', 'node_modules/'] },
  ...tseslint.configs.recommended,
];
