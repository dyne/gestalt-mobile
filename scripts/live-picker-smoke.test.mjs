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
  NativeContextCompletion,
} from './live-picker-smoke.mjs';

const nativeCell = '1';
const running = (cell = nativeCell) => `Script running with cell ID ${cell}`;
const completed = (
  result = { content: [{ type: 'text', text: 'actual controlled MCP output' }], isError: false },
) => `Script completed\nWall time 82.1 seconds\nOutput:\n${JSON.stringify(result)}`;
const reply = (callId, output) => [{ type: 'custom_tool_call_output', call_id: callId, output }];

test('requires an actual completed MCP result for immediate completion', () => {
  const probe = new NativeContextCompletion({ startedAt: 0, now: () => 1000 });
  assert.deepEqual(probe.advance(reply('root-4', completed())), { state: 'completed' });
  assert.equal(probe.diagnostics().nativeState, 'completed');
  assert.equal(probe.diagnostics().cellObserved, false);
  assert.equal(probe.diagnostics().waits, 0);
  assert.throws(() => probe.advance(reply('root-4', completed())), /CONTEXT_PROTOCOL_TERMINAL/);
});

test('waits only the exact Native cell through repeated yield without redispatching ctx', () => {
  let clock = 10_000;
  const probe = new NativeContextCompletion({ startedAt: 0, now: () => clock });
  assert.equal(JSON.stringify(running() + '\nWall time 10.0 seconds\nOutput:\n').length, 66);
  let next = probe.advance(reply('root-4', running()));
  assert.deepEqual(next, {
    state: 'wait',
    callId: 'root-context-wait-1',
    arguments: {
      cell_id: nativeCell,
      yield_time_ms: 10_000,
      max_tokens: 2000,
    },
  });
  assert.equal(probe.diagnostics().nativeState, 'pending');
  clock = 20_000;
  next = probe.advance(
    reply(
      next.callId,
      `Script running with cell ID ${nativeCell}\nWall time 10.0 seconds\nOutput:\n`,
    ),
  );
  assert.equal(next.callId, 'root-context-wait-2');
  assert.equal(next.arguments.cell_id, nativeCell);
  clock = 90_000;
  assert.deepEqual(
    probe.advance([
      {
        type: 'function_call_output',
        call_id: next.callId,
        output: [
          {
            type: 'input_text',
            text: 'Script completed\nWall time 10.003 seconds (code-mode 10.000 seconds; overhead 0.003 seconds)\nOutput:\n',
          },
          {
            type: 'input_text',
            text: JSON.stringify({ content: [{ type: 'text', text: 'actual result' }] }),
          },
        ],
      },
    ]),
    { state: 'completed' },
  );
  assert.equal(probe.diagnostics().waits, 2);
  assert.equal(probe.diagnostics().elapsedMs, 90_000);
  assert.equal(Object.hasOwn(probe.diagnostics(), 'cellId'), false);
});

test('does not reset the original300s deadline when a cell yields', () => {
  let clock = 299_999;
  const probe = new NativeContextCompletion({ startedAt: 0, now: () => clock });
  const next = probe.advance(reply('root-4', running()));
  assert.equal(next.arguments.yield_time_ms, 1);
  clock = 300_000;
  assert.throws(
    () => probe.advance(reply(next.callId, completed())),
    /CONTEXT_OBSERVATION_DEADLINE/,
  );
  assert.equal(probe.diagnostics().state, 'failed');
});

test('limits immediate repeated yields even when no wall time has elapsed', () => {
  const probe = new NativeContextCompletion({ startedAt: 0, now: () => 0 });
  let callId = 'root-4';
  for (let wait = 0; wait < 30; wait++) callId = probe.advance(reply(callId, running())).callId;
  assert.throws(() => probe.advance(reply(callId, running())), /CONTEXT_WAIT_LIMIT/);
});

test('preserves pinned Native generation-qualified counters and refuses malformed values', () => {
  for (const cell of ['2', 'g2:1', 'g9:18446744073709551615']) {
    const probe = new NativeContextCompletion({ startedAt: 0, now: () => 0 });
    const next = probe.advance(reply('root-4', running(cell)));
    assert.equal(next.arguments.cell_id, cell);
    assert.ok(!JSON.stringify(probe.diagnostics()).includes('g9:'));
  }
  for (const cell of [
    '0',
    '-1',
    '01',
    'g0:1',
    'g1:1',
    'g2:01',
    'g2:',
    '18446744073709551616',
    'g18446744073709551616:1',
    'g2:1\nScript completed',
  ]) {
    const probe = new NativeContextCompletion({ startedAt: 0, now: () => 0 });
    assert.throws(() => probe.advance(reply('root-4', running(cell))), /CONTEXT_/);
  }
});

test('refuses changed, malformed, missing and duplicate cell replies', () => {
  for (const output of [
    running('bad-id'),
    `echo ${running()}`,
    running() + '\nScript completed',
    'Script completed',
    completed({ content: [], isError: false }),
    completed({ content: [{ type: 'text', text: 'echo only' }], isError: 'false' }),
    completed({ content: [{ type: 'text', text: 'echo only' }], isError: true }),
  ]) {
    const probe = new NativeContextCompletion({ startedAt: 0, now: () => 0 });
    assert.throws(() => probe.advance(reply('root-4', output)), /CONTEXT_/);
    assert.equal(probe.diagnostics().state, 'failed');
  }
  const changed = new NativeContextCompletion({ startedAt: 0, now: () => 0 });
  const next = changed.advance(reply('root-4', running()));
  assert.throws(() => changed.advance(reply(next.callId, running('2'))), /CONTEXT_CELL_CHANGED/);
  for (const input of [
    [],
    reply('other-cell', completed()),
    [...reply('root-4', running()), ...reply('root-4', running())],
  ]) {
    const probe = new NativeContextCompletion({ startedAt: 0, now: () => 0 });
    assert.throws(() => probe.advance(input), /CONTEXT_RESPONSE_MISSING_OR_DUPLICATE/);
  }
});

test('classifies actual failures without retaining tokens, text or a cell id', () => {
  for (const output of [
    'Script failed\nScript error:\nprivate-token-canary',
    'Script terminated',
    completed({ error: { message: 'private-token-canary' } }),
  ]) {
    const probe = new NativeContextCompletion({ startedAt: 0, now: () => 0 });
    assert.throws(() => probe.advance(reply('root-4', output)), /CONTEXT_/);
    const diagnostic = JSON.stringify(probe.diagnostics());
    assert.ok(!diagnostic.includes('private-token-canary'));
    assert.equal(probe.diagnostics().state, 'failed');
  }
});

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

test('approved proof diagnostics path is eligible while unrelated product and dependency changes still refuse', () => {
  assert.deepEqual(validateSmokeDelta(['scripts/live-production-edit-diagnostics.mjs']), [
    'scripts/live-production-edit-diagnostics.mjs',
  ]);
  for (const path of [
    'src/server/platform/live-design/installed-policy.ts',
    'src/server/platform/live-design/process-identity.ts',
    'package.json',
    'package-lock.json',
    'src/client/RelayApp.svelte',
    'scripts/unreviewed-diagnostics.mjs',
  ])
    assert.throws(
      () => validateSmokeDelta(['scripts/live-production-edit-diagnostics.mjs', path]),
      /independent proof inputs changed/,
    );
});

test('fresh picker diagnostic never expands historical baseline eligibility to changed runtime inputs', () => {
  assert.equal(
    proofMode({ eventName: 'push', message: '[picker-diagnostic]' }),
    'picker-diagnostic',
  );
  for (const path of [
    'src/server/platform/codex/session-runtime.ts',
    'src/server/platform/live-design/owning-runtime.test.ts',
    'src/server/platform/live-design/production-shutdown.test.ts',
  ])
    assert.throws(() => validateSmokeDelta([path]));
  assert.equal(
    proofMode({ eventName: 'workflow_dispatch', preflight: true, pickerDiagnostic: true }),
    'picker-diagnostic',
  );
  assert.throws(() =>
    proofMode({ eventName: 'workflow_dispatch', pickerSmoke: true, pickerDiagnostic: true }),
  );
});
