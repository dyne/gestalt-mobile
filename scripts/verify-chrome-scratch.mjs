/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { installedChrome } from './installed-chrome.ts';

assert.equal(process.platform, 'linux', 'This regression exercises Linux socket paths');
const root = await mkdtemp(join(tmpdir(), 'chrome-scratch-regression-'));
let browser;
try {
  const directory = join(
    root,
    'workspace with spaces',
    'tmp',
    'sessions',
    'mobile-' + 'a'.repeat(64),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const environment = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory };
  const selection = installedChrome(environment);
  // The only difference between launches is the spelling of the same directory.
  const options = { channel: selection.channel, ...selection.launchOptions, chromiumSandbox: true };
  await assert.rejects(
    chromium.launch({ ...options, env: environment }),
    /Socket path too long/,
    'The baseline must reproduce the original Chrome failure',
  );
  browser = await chromium.launch(options);
  const page = await browser.newPage();
  await page.goto('data:text/html,<title>Owned scratch</title><h1>Ready</h1>');
  assert.equal(await page.title(), 'Owned scratch');
  assert.equal(await realpath(options.env.TMPDIR), await realpath(directory));
  await browser.close();
  browser = undefined;
  console.log('Chrome scratch regression: baseline reproduced; fixed launch and page check passed');
} finally {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
