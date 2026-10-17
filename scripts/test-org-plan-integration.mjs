/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// CI checks out this immutable compatible revision; ordinary unit tests need no network.
const revision = '3a7d87be1eb61c1ae7e9157292e2f13988b7dc29';
const checkout = process.argv[2];
if (!checkout) throw new Error('Pass the compatible gestalt-agents checkout directory');
const directory = resolve(checkout);
const actual = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: directory,
  encoding: 'utf8',
}).trim();
if (actual !== revision)
  throw new Error('Org Plan integration requires the pinned Agents revision');
const dirty = execFileSync('git', ['status', '--porcelain'], {
  cwd: directory,
  encoding: 'utf8',
});
if (dirty.trim()) throw new Error('Org Plan integration requires a clean Agents checkout');
const helper = resolve(directory, 'plugins/gestalt/skills/org-plan/scripts/org-plan');
accessSync(helper, constants.X_OK);
const reportDirectory = mkdtempSync(join(tmpdir(), 'org-plan-integration-'));
const reportPath = join(reportDirectory, 'results.json');
try {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'src/server/features/autopilot/application/service.test.ts',
      '-t',
      'hands accepted L10 to exactly one root turn|hands accepted L9 through a nested stack',
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, GESTALT_TEST_ORG_PLAN_HELPER: helper },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Org Plan integration test process failed');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.numPassedTests !== 2 || report.numFailedTests !== 0)
    throw new Error('Org Plan integration requires both single and nested handoff cases to pass');
} finally {
  rmSync(reportDirectory, { recursive: true, force: true });
}
