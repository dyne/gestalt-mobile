/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const expected = JSON.parse(
  readFileSync(new URL('../src/server/platform/codex/protocol-version.json', import.meta.url)),
).version;
const installed = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
if (installed !== expected) {
  console.error(`Codex protocol mismatch: expected ${expected}, found ${installed}`);
  process.exitCode = 1;
}
