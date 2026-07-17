/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';

import { applySourceHeaders } from './license-headers.mjs';
const output = new URL('../src/server/platform/codex/generated/', import.meta.url);
mkdirSync(output, { recursive: true });
execFileSync('codex', ['app-server', 'generate-ts', '--experimental', '--out', output.pathname], {
  stdio: 'inherit',
});
applySourceHeaders(generatedTypeScriptFiles(output));
writeFileSync(
  new URL('../src/server/platform/codex/protocol-version.json', import.meta.url),
  `${JSON.stringify({ version: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() }, null, 2)}\n`,
);

function generatedTypeScriptFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map(
      (entry) =>
        new URL(entry.name, new URL(`${entry.parentPath.replace(/\\/g, '/')}/`, directory))
          .pathname,
    );
}
