/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// These independent lanes passed even though the enclosing run failed before
// actual UI Start. They are diagnostic reuse only, never acceptance evidence.
export const pickerSmokeBaseline = Object.freeze({
  runId: 39068238982,
  commit: '73764628d350e1c69af64b460502c2655cb6861f',
  artifactId: 12113569089,
  artifactSha256: 'db42a0e830501a2c1af30f257d940dc2312a8d0cfb03ecbacfd9c8c3a4922157',
});
/** Never retain tool text: it can contain private paths, prompts or credentials.
 * Markers classify a failed probe; echoed source is never evidence of success. */
export function contextToolResultDiagnostic(input) {
  const item = input.find(
    (entry) =>
      entry.call_id === 'root-4' &&
      ['function_call_output', 'custom_tool_call_output'].includes(entry.type),
  );
  const serialized = JSON.stringify(item?.output ?? null);
  const bounded = serialized.slice(0, 262144);
  return {
    present: item !== undefined,
    outputBytes: Buffer.byteLength(serialized),
    inspectedBytesBounded: serialized.length > bounded.length,
    markers: [
      'context-call-unavailable',
      'live-context-unavailable',
      'live-tool-unavailable',
      'native-policy-unavailable',
      'context-call-cancelled',
      'invalid-native-response',
      'package-changed',
      'runtime-changed',
      'interpreter-changed',
      'configuration-changed',
      'stale-admission-receipt',
      'NATIVE_CONTEXT_CATALOG_UNAVAILABLE',
      'SyntaxError',
      'ReferenceError',
      'ERR_MODULE_NOT_FOUND',
      'Cannot find module',
      'No JavaScript runtime available',
      'Invalid Live executor temporary directory',
      'EACCES:',
      'EPERM:',
      'EROFS:',
      'ENOENT:',
      'Permission denied',
      'Read-only file system',
      'timed out',
      'Timeout',
      'Error:',
    ].filter((marker) => bounded.includes(marker)),
  };
}
const permittedDelta = new Set([
  '.github/workflows/live-caddy-proof.yml',
  'scripts/live-picker-smoke.mjs',
  'scripts/live-picker-smoke.test.mjs',
  'scripts/live-production-entrypoint-proof.mjs',
  'scripts/live-production-edit-browser.mjs',
  'scripts/live-production-edit-browser-host.mjs',
  'src/server/platform/live-design/production-controller.ts',
  'src/server/platform/live-design/production-installed-policy.test.ts',
]);
export function proofMode({ eventName, message = '', preflight = false, pickerSmoke = false }) {
  const full = message.includes('[full-native]');
  const smoke = pickerSmoke || (eventName === 'push' && message.includes('[picker-smoke]'));
  assert.ok(!(smoke && full), 'conflicting proof modes');
  if (smoke) return 'picker-smoke';
  if (preflight || (eventName === 'push' && !full)) return 'preflight';
  return 'full';
}
export function validateSmokeDelta(paths) {
  assert.ok(
    paths.every((path) => permittedDelta.has(path)),
    'independent proof inputs changed',
  );
  return [...paths].sort();
}
function workflowStep(source, name) {
  const start = source.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, 'missing independent proof step');
  const next = source.indexOf('\n      - ', start + 1);
  return source.slice(start, next < 0 ? undefined : next).replace(/^        if:.*\n/gm, '');
}
export function validateSmokeWorkflow(before, after) {
  for (const name of [
    'Provision exact original interpreter on disposable hosted VM',
    'Read-only accepted Manager input',
    'Read-only accepted Agents input',
    'Verify exact accepted dependency trees',
    'Prepare verified existing native artifacts and pinned test tools',
    'Real temporary Caddy and actual same-UID managed project denial',
    'Actual owning native model tools and permitted child with deterministic provider',
    'Real helper browser proof in separate network with trusted TLS',
    'Actual pinned helper and project process namespaces with native confinement',
  ])
    assert.equal(
      workflowStep(after, name),
      workflowStep(before, name),
      'independent workflow input changed',
    );
}
export function validateSmokeEvidence({ native, remote, tests, cleanup }) {
  assert.equal(native.passed, true);
  assert.ok(Object.keys(native.checks ?? {}).length >= 15);
  assert.ok(Object.values(native.checks).every((value) => value === true));
  for (const key of [
    'trustedTls',
    'separateBrowserNetwork',
    'helperLoopbackDenied',
    'realSimpleWebAuthnEnrollment',
    'launchPkceViaValidatedOpener',
    'clearedGrantFragment',
    'hostOnlyCookiesOnDistinctHosts',
    'realPublishedHelperOverlay',
    'helperSseConnectedAndErrorReply',
    'helperSseClosedAfterRevocation',
    'actualHelperAndViteManagedPolicy',
    'controllerPrivate',
  ])
    assert.equal(remote[key], true, `missing independent remote proof: ${key}`);
  assert.equal(remote.ignoreHttpsErrors, false);
  assert.equal(tests.success, true);
  assert.equal(tests.numFailedTests, 0);
  assert.ok(tests.numPassedTests >= 148);
  assert.equal(cleanup.cleanupFailures, 0);
  assert.equal(cleanup.stoppedProjectListeners, 4);
}
export function verifyPickerSmoke({ archive, evidence, output }) {
  assert.equal(
    createHash('sha256').update(readFileSync(archive)).digest('hex'),
    pickerSmokeBaseline.artifactSha256,
  );
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const paths = git('diff', '--name-only', '-z', pickerSmokeBaseline.commit, 'HEAD')
    .split('\0')
    .filter(Boolean);
  const changedPaths = validateSmokeDelta(paths);
  const workflow = '.github/workflows/live-caddy-proof.yml';
  validateSmokeWorkflow(
    git('show', `${pickerSmokeBaseline.commit}:${workflow}`),
    readFileSync(workflow, 'utf8'),
  );
  const json = (path) => JSON.parse(readFileSync(resolve(evidence, path), 'utf8'));
  validateSmokeEvidence({
    native: json('native-model-tools/native-model-tools-proof.json'),
    remote: json('remote-proof.json'),
    tests: json('vitest.json'),
    cleanup: json('cleanup-proof.json'),
  });
  const receipt = {
    schemaVersion: 1,
    mode: 'picker-smoke',
    diagnosticOnly: true,
    acceptanceGatesOmitted: true,
    baseline: pickerSmokeBaseline,
    changedPaths,
    candidate: git('rev-parse', 'HEAD').trim(),
    omittedIndependentLanes: ['caddy-managed-denial', 'native-model-tools', 'remote-browser'],
    fullExactCandidateStillRequired: true,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , archive, evidence, output] = process.argv;
  assert.ok(archive && evidence && output);
  const result = verifyPickerSmoke({ archive, evidence, output });
  process.stdout.write(
    JSON.stringify({
      mode: result.mode,
      diagnosticOnly: true,
      baselineRun: result.baseline.runId,
      changedPaths: result.changedPaths,
    }) + '\n',
  );
}
