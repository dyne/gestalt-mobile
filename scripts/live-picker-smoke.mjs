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
import { performance } from 'node:perf_hooks';

const contextObservationMs = 300_000;
// Pinned Native allocates positive u64 counters; later host generations prefix gN:.
const cellIdPattern = '(?:g[1-9][0-9]{0,19}:)?[1-9][0-9]{0,19}';
function contextCheck(condition, reason) {
  if (!condition) throw new Error(reason);
}
function nativeContextResponse(output) {
  const text =
    typeof output === 'string'
      ? output
      : Array.isArray(output) &&
          output.every((part) => part.type === 'input_text' && typeof part.text === 'string')
        ? output.map((part) => part.text).join('\n')
        : undefined;
  contextCheck(text && Buffer.byteLength(text) <= 262144, 'CONTEXT_RESULT_INVALID');
  const newline = text.indexOf('\n');
  const status = newline < 0 ? text : text.slice(0, newline);
  let payload = newline < 0 ? '' : text.slice(newline + 1);
  // Pinned Native emits this header; its status-only compatibility form has
  // also been observed. Neither arbitrary text nor an echoed banner is status.
  payload = payload.replace(
    /^Wall time \d+(?:\.\d+)? seconds(?: \(code-mode \d+(?:\.\d+)? seconds; overhead -?\d+(?:\.\d+)? seconds\))?\nOutput:\n/,
    '',
  );
  const pending = new RegExp(`^Script running with cell ID (${cellIdPattern})$`).exec(status);
  if (pending) {
    const values = pending[1].replace(/^g/, '').split(':').map(BigInt);
    contextCheck(
      values.every((value) => value <= 18446744073709551615n) &&
        (values.length === 1 || values[0] >= 2n),
      'CONTEXT_CELL_INVALID',
    );
    contextCheck(payload.trim() === '', 'CONTEXT_PENDING_OUTPUT_INVALID');
    return { state: 'pending', cellId: pending[1] };
  }
  if (status === 'Script failed' || status === 'Script terminated') return { state: 'failed' };
  contextCheck(status === 'Script completed', 'CONTEXT_STATUS_INVALID');
  return { state: 'completed', payload };
}
function validateContextMcpResult(payload) {
  let result;
  try {
    result = JSON.parse(payload.trim());
  } catch {
    throw new Error('CONTEXT_MCP_RESULT_INVALID');
  }
  contextCheck(
    result && !Array.isArray(result) && typeof result === 'object',
    'CONTEXT_MCP_RESULT_INVALID',
  );
  contextCheck(
    result.isError === undefined || typeof result.isError === 'boolean',
    'CONTEXT_MCP_RESULT_INVALID',
  );
  contextCheck(result.isError !== true && result.error == null, 'CONTEXT_MCP_FAILED');
  contextCheck(
    Array.isArray(result.content) &&
      result.content.length > 0 &&
      result.content.every((part) => part.type === 'text' && typeof part.text === 'string'),
    'CONTEXT_MCP_RESULT_INVALID',
  );
}

/** One already-dispatched probe. Waits never mint another execution or extend
 * the original browser observation window. Native cell IDs remain private. */
export class NativeContextCompletion {
  #startedAt;
  #now;
  #cellId;
  #callId = 'root-4';
  #state = 'awaiting-result';
  #nativeState = 'unclassified';
  #waits = 0;
  #failure;
  constructor({ startedAt, now = () => performance.now() }) {
    contextCheck(
      Number.isFinite(startedAt) && startedAt <= now(),
      'CONTEXT_OBSERVATION_START_INVALID',
    );
    this.#startedAt = startedAt;
    this.#now = now;
  }
  expectedCallId() {
    return this.#callId;
  }
  diagnostics() {
    return {
      state: this.#state,
      nativeState: this.#nativeState,
      waits: this.#waits,
      cellObserved: this.#cellId !== undefined,
      elapsedMs: Math.max(0, Math.round(this.#now() - this.#startedAt)),
      budgetMs: contextObservationMs,
      ...(this.#failure ? { failure: this.#failure } : {}),
    };
  }
  advance(input) {
    try {
      contextCheck(!['completed', 'failed'].includes(this.#state), 'CONTEXT_PROTOCOL_TERMINAL');
      const remaining = Math.floor(contextObservationMs - (this.#now() - this.#startedAt));
      contextCheck(remaining > 0, 'CONTEXT_OBSERVATION_DEADLINE');
      const matches = input.filter(
        (entry) =>
          entry.call_id === this.#callId &&
          ['function_call_output', 'custom_tool_call_output'].includes(entry.type),
      );
      contextCheck(matches.length === 1, 'CONTEXT_RESPONSE_MISSING_OR_DUPLICATE');
      const response = nativeContextResponse(matches[0].output);
      this.#nativeState = response.state;
      contextCheck(response.state !== 'failed', 'CONTEXT_SCRIPT_FAILED');
      if (response.state === 'completed') {
        validateContextMcpResult(response.payload);
        contextCheck(
          this.#now() - this.#startedAt < contextObservationMs,
          'CONTEXT_OBSERVATION_DEADLINE',
        );
        this.#state = 'completed';
        return { state: 'completed' };
      }
      contextCheck(!this.#cellId || this.#cellId === response.cellId, 'CONTEXT_CELL_CHANGED');
      contextCheck(this.#waits < contextObservationMs / 10_000, 'CONTEXT_WAIT_LIMIT');
      this.#cellId = response.cellId;
      this.#state = 'pending';
      this.#waits++;
      this.#callId = `root-context-wait-${this.#waits}`;
      const waitRemaining = Math.floor(contextObservationMs - (this.#now() - this.#startedAt));
      contextCheck(waitRemaining > 0, 'CONTEXT_OBSERVATION_DEADLINE');
      return {
        state: 'wait',
        callId: this.#callId,
        arguments: {
          cell_id: this.#cellId,
          yield_time_ms: Math.min(10_000, waitRemaining),
          max_tokens: 2000,
        },
      };
    } catch (error) {
      this.#state = 'failed';
      // Only fixed local classifications enter evidence; never Native output.
      const reason = error instanceof Error ? error.message : '';
      this.#failure = /^CONTEXT_[A-Z_]+$/.test(reason) ? reason : 'CONTEXT_RESULT_INVALID';
      throw new Error(this.#failure);
    }
  }
}

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
export function contextToolResultDiagnostic(input, callId = 'root-4') {
  const item = input.find(
    (entry) =>
      entry.call_id === callId &&
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
  'scripts/live-production-proof-lanes.mjs',
  'scripts/live-production-proof-lanes.test.mjs',
  'scripts/live-production-edit-provider.mjs',
  'scripts/live-production-edit-diagnostics.mjs',
  'scripts/live-production-edit-provider.test.mjs',
  'scripts/live-production-recovery-proof.mjs',
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
