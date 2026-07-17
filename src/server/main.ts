#!/usr/bin/env node

/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { runCli } from './cli.js';

try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Gestalt Mobile startup failed');
  process.exitCode = 1;
}
