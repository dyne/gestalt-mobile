/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Prerequisite evidence only. Never launches native processes or grants readiness.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  LIVE_CODEX_SHA256,
  LIVE_CODEX_BWRAP_SHA256,
  LIVE_CODEX_SANDBOX_SHA256,
  LIVE_CODEX_CODE_MODE_HOST_SHA256,
} from '../dist/server/server/platform/live-design/native-contract.js';

const evidence = resolve(process.env.LIVE_MODEL_EVIDENCE ?? 'test-results/live-model-tools');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
const report = { schemaVersion: 1, passed: false, stage: 'opt-in', genuine: false, checks: {} };
try {
  assert.equal(process.env.LIVE_NATIVE_MODEL_PROOF, '1');
  report.stage = 'checkout-provenance';
  assert.match(process.env.LIVE_PROOF_EXPECTED_HEAD ?? '', /^[a-f0-9]{40}$/);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  assert.equal(head, process.env.LIVE_PROOF_EXPECTED_HEAD);
  report.provenance = { head, tree, expectedHead: process.env.LIVE_PROOF_EXPECTED_HEAD };
  assert.ok(process.env.RUNNER_TEMP);
  // Reviewed GNU candidate and signed official same-source code-mode host.
  const platform = dirname(realpathSync(process.env.LIVE_HOST_CODEX_BINARY));
  for (const [name, relative, expected] of [
    ['native-binary', 'codex', LIVE_CODEX_SHA256],
    ['bundled-bwrap', 'codex-resources/bwrap', LIVE_CODEX_BWRAP_SHA256],
    ['sandbox-helper', 'codex-linux-sandbox', LIVE_CODEX_SANDBOX_SHA256],
    ['code-mode-host', 'codex-code-mode-host', LIVE_CODEX_CODE_MODE_HOST_SHA256],
  ]) {
    report.stage = `${name}-discovery`;
    const path = join(platform, relative);
    assert.equal(realpathSync(path), path);
    const info = statSync(path);
    assert.ok(info.isFile() && (info.mode & 0o111) !== 0);
    report.stage = `${name}-digest`;
    const measured = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(measured, expected);
    report.checks[name] = { sha256: measured, verified: true };
  }
  report.passed = true;
  report.stage = 'prerequisites-verified';
} catch {
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(evidence, 'native-model-prerequisites.json'),
    JSON.stringify(report, null, 2) + '\n',
    {
      mode: 0o600,
    },
  );
  // Fixed stage names and code hashes only; no paths, environment, responses or secrets.
  process.stdout.write(JSON.stringify(report) + '\n');
}
