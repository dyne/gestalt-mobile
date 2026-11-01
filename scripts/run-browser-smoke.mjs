/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSmokeReport } from './browser-smoke-contract.mjs';

const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
const args = ['test', '--config', 'playwright.smoke.config.ts'];

/** Fixed selection and a fresh structured report prevent filtered/empty false greens. */
export function runBrowserSmoke({
  listOnly = false,
  env = process.env,
  run = (argv, options) => spawnSync(process.execPath, [cli, ...argv], options),
  readReport = (path) => JSON.parse(readFileSync(path, 'utf8')),
  prepareReport = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
  },
} = {}) {
  const discoveryEnv = { ...env };
  for (const key of [
    'PLAYWRIGHT_JSON_OUTPUT_NAME',
    'PLAYWRIGHT_JSON_OUTPUT_FILE',
    'PLAYWRIGHT_JSON_OUTPUT_DIR',
  ])
    delete discoveryEnv[key];
  const discovery = run([...args, '--list', '--reporter=json'], {
    env: discoveryEnv,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (discovery.status !== 0) {
    console.error(discovery.stderr || 'Smoke discovery failed');
    return discovery.status || 1;
  }
  const inventory = validateSmokeReport(JSON.parse(discovery.stdout));
  console.log(JSON.stringify({ smokeDiscovery: inventory }));
  if (listOnly) return 0;
  const reportPath = resolve(
    env.PLAYWRIGHT_JSON_OUTPUT_NAME ??
      `test-results/browser-smoke-${env.PLAYWRIGHT_OUTPUT_ID ?? 'local'}.json`,
  );
  prepareReport(reportPath);
  const execution = run([...args, '--reporter=list,json'], {
    env: { ...discoveryEnv, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath },
    stdio: 'inherit',
  });
  if (execution.status !== 0) return execution.status || 1;
  const result = validateSmokeReport(readReport(reportPath), true);
  console.log(JSON.stringify({ smokePassed: result.tests, report: reportPath }));
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = process.argv.slice(2);
    if (options.length > 1 || (options.length === 1 && options[0] !== '--list'))
      throw new Error('Usage: node scripts/run-browser-smoke.mjs [--list]');
    process.exitCode = runBrowserSmoke({ listOnly: options[0] === '--list' });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
