/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  proofMode,
  validateSmokeDelta,
  validateSmokeEvidence,
  validateSmokeWorkflow,
  contextToolResultDiagnostic,
} from './live-picker-smoke.mjs';

test('context failure classification retains fixed markers but never raw tool text', () => {
  const secret = 'private-cookie-and-token-canary';
  const result = contextToolResultDiagnostic([
    {
      type: 'custom_tool_call_output',
      call_id: 'root-4',
      output: `Error: context-call-unavailable ${secret}`,
    },
  ]);
  assert.equal(result.present, true);
  assert.deepEqual(result.markers, ['context-call-unavailable', 'Error:']);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(contextToolResultDiagnostic([]).present, false);
  const echoOnly = contextToolResultDiagnostic([
    {
      type: 'custom_tool_call_output',
      call_id: 'root-4',
      output: "console.log('production-context-denied')",
    },
  ]);
  assert.deepEqual(echoOnly.markers, []);
  assert.equal(Object.hasOwn(echoOnly, 'success'), false);
});

test('smoke requires explicit selection; ordinary push, PR and dispatch retain their modes', () => {
  assert.equal(proofMode({ eventName: 'push' }), 'preflight');
  assert.equal(proofMode({ eventName: 'push', message: '[full-native]' }), 'full');
  assert.equal(proofMode({ eventName: 'pull_request' }), 'full');
  assert.equal(proofMode({ eventName: 'workflow_dispatch', preflight: true }), 'preflight');
  assert.equal(proofMode({ eventName: 'workflow_dispatch', preflight: false }), 'full');
  assert.equal(proofMode({ eventName: 'push', message: '[picker-smoke]' }), 'picker-smoke');
  assert.equal(
    proofMode({ eventName: 'workflow_dispatch', preflight: true, pickerSmoke: true }),
    'picker-smoke',
  );
  assert.throws(() => proofMode({ eventName: 'push', message: '[picker-smoke] [full-native]' }));
});

test('only reviewed diagnostic and controller deltas may reuse independent baseline proofs', () => {
  assert.deepEqual(
    validateSmokeDelta(['src/server/platform/live-design/production-controller.ts']),
    ['src/server/platform/live-design/production-controller.ts'],
  );
  for (const path of [
    'package-lock.json',
    'scripts/live-model-tools-proof.mjs',
    'scripts/live-remote-proof.mjs',
    'src/server/platform/live-design/installed-policy.ts',
    'src/server/platform/live-design/native-contract.ts',
  ])
    assert.throws(() => validateSmokeDelta([path]));
});

test('workflow mode conditions may differ, but dependency pins and independent commands cannot', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/live-caddy-proof.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotThrow(() =>
    validateSmokeWorkflow(
      workflow,
      workflow.replaceAll("if: steps.proof-mode.outputs.mode == 'full'", 'if: false'),
    ),
  );
  assert.throws(() =>
    validateSmokeWorkflow(
      workflow,
      workflow.replace('dfdeabd2ffdbdb6c429a39c3e81286b611af7734', '0'.repeat(40)),
    ),
  );
  assert.throws(() =>
    validateSmokeWorkflow(
      workflow,
      workflow.replace('node scripts/live-model-tools-proof.mjs', 'true'),
    ),
  );
});

test('missing or failed independent evidence refuses smoke eligibility', () => {
  const evidence = {
    native: {
      passed: true,
      checks: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [String(i), true])),
    },
    remote: Object.fromEntries(
      [
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
      ].map((key) => [key, true]),
    ),
    tests: { success: true, numFailedTests: 0, numPassedTests: 148 },
    cleanup: { cleanupFailures: 0, stoppedProjectListeners: 4 },
  };
  evidence.remote.ignoreHttpsErrors = false;
  assert.doesNotThrow(() => validateSmokeEvidence(evidence));
  for (const mutate of [
    (e) => {
      e.native.passed = false;
    },
    (e) => {
      e.native.checks['0'] = false;
    },
    (e) => {
      e.remote.trustedTls = false;
    },
    (e) => {
      e.remote.ignoreHttpsErrors = true;
    },
    (e) => {
      e.tests.numFailedTests = 1;
    },
    (e) => {
      e.cleanup.cleanupFailures = 1;
    },
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.throws(() => validateSmokeEvidence(changed));
  }
});
