#!/usr/bin/env node

/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) throw new Error('Usage: check-package-contents.mjs <npm-pack-json>');
const [report] = JSON.parse(await readFile(path, 'utf8'));
const files = report.files.map((file) => file.path);
const required = ['package.json', 'README.md', 'LICENSE', 'dist/server/server/main.js'];
const invalid = files.filter(
  (file) =>
    !['package.json', 'README.md', 'LICENSE'].includes(file) &&
    !file.startsWith('dist/server/') &&
    !file.startsWith('dist/client/'),
);
const forbidden = files.filter((file) =>
  /\.org$|\.map$|\.sqlite$|\.test\.js$|\.integration\.test\.js$|(^|\/)(src|scripts|test|tests|\.github)(\/|$)/.test(
    file,
  ),
);
const missing = required.filter((file) => !files.includes(file));
if (invalid.length || forbidden.length || missing.length)
  throw new Error(`Invalid package payload: ${JSON.stringify({ invalid, forbidden, missing })}`);
