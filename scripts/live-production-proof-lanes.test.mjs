/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createSerialProfile, validateSerialProfile } from './live-production-edit-diagnostics.mjs';
import {
  aggregateLanes,
  aggregateDiagnostic,
  diagnosticLanes,
  diagnosticPickerChecks,
  validateDiagnosticPicker,
  birthCurrent,
  fullLanes,
  fullAssertionOwners,
  laneChecks,
  modelConfinementChecks,
  independentChecks,
  openRecoveryHandoff,
  handoffRequest,
  processBirth,
  observeRecoveryPhase,
  settleRecoveryDriver,
  productionLane,
  writeLaneReceipt,
  proofPins,
  selectedLanes,
  loadLanePacket,
  validateEditingContinuity,
  readEditingAnchor,
  editingPhaseBound,
  validateEditingPhaseBound,
  phaseBoundRemaining,
  fixedProofFailure,
} from './live-production-proof-lanes.mjs';

const identity = { candidate: 'a'.repeat(40), tree: 'b'.repeat(40), runId: '123', ...proofPins };
function production(lane) {
  const report = {
    passed: true,
    cleanupComplete: true,
    productionLane: lane,
    provenance: { head: identity.candidate, tree: identity.tree, ...proofPins },
    nativeBinarySha256: proofPins.native,
    sourceInventory: { signatureVerified: true, captureGenerationMatchesLiveGeneration: true },
    checks: Object.fromEntries(laneChecks[lane].map((name) => [name, true])),
    editBrowser: {
      proofLane: lane,
      trustedTls: true,
      ignoreHttpsErrors: false,
      separateBrowserNetwork: true,
      separateBrowserMountNamespace: true,
      openThroughMobileControls: true,
      extraPollOwnerDenied: true,
      genuineProvider: false,
      hmrUpdates: 1,
      realPickerGenerateAccept: lane === 'accept-steer',
      realPickerSteer: lane === 'accept-steer',
      acceptContinuity: {
        freshDocumentHelperConnected: true,
        visibleChrome: true,
        acceptedHeading: true,
        elapsedMs: 1,
      },
      actualTabHiddenBeyondEightSeconds: lane === 'accept-steer',
      realPickerManualApply: lane === 'manual-discard',
      realPickerDiscard: lane === 'manual-discard',
    },
    laneCanonicalEvents: (lane === 'accept-steer'
      ? ['generate', 'accept', 'steer']
      : ['manual_edit_apply', 'generate', 'discard']
    ).map((kind) => ({
      kind,
      stage: 'acknowledged',
      history: ['received', 'dispatched', 'applied', 'acknowledged'],
    })),
    recovery: {
      originalBirthPreservedDuringSurvivor: true,
      replacementBirthAfterActualExit: true,
      originalManifestBytesPreserved: true,
      durableInboxRemainsSharedAcrossGenerations: true,
      captures: ['a', 'b', 'c'],
      generations: [1, 2, 3, 4, 5],
    },
    recoveryHandoff: { continuations: 1, cancelled: false, sameDriverBirth: true },
  };
  if (lane === 'accept-steer') {
    const phaseB = {
      ...structuredClone(report.editBrowser),
      editingPhase: 'steer',
      observedGeneration: 3,
      realPickerGenerateAccept: false,
      exchangePosts: 1,
      postResumeContinuity: structuredClone(report.editBrowser.acceptContinuity),
    };
    const phaseA = {
      ...structuredClone(report.editBrowser),
      editingPhase: 'accepted',
      observedGeneration: 1,
      exchangePosts: 1,
      realPickerSteer: false,
      actualTabHiddenBeyondEightSeconds: false,
    };
    report.recoveryHandoff.birthDigest = createHash('sha256')
      .update(JSON.stringify({ pid: 1, start: '1', boot: 'a'.repeat(36) }))
      .digest('hex');
    report.editingContinuity = {
      kind: 'continuity-with-explicit-recovery',
      phaseATotalMs: 1200000,
      phaseBTotalMs: 900000,
      actionFinishedOffsetMs: 2300000,
      cleanupFinishedOffsetMs: 2400000,
      phaseAllocationMs: [1260000, 1020000, 180000],
      originalGeneration: 1,
      recoveryGeneration: 2,
      resumedGeneration: 3,
      acceptedSourceDigest: 'd'.repeat(64),
      canonicalGenerations: { generate: 1, accept: 1, steer: 3 },
      resumeDispatches: 1,
      originalNativeSurvived: true,
      genuineBrowserClosed: true,
      newSignedCapture: true,
      sameNativeThreadSelection: true,
      noModelOrSourceReplay: true,
      oldCookieDenied: true,
      oldCookieDeniedStatus: 401,
      oldCookieDeniedCode: 'LIVE_AUTH_REQUIRED',
      staleGrantDenied: true,
      phaseA,
      phaseB,
    };
  }
  if (lane === 'manual-discard') {
    report.modelWorkload = 'owning-edit-only';
    report.provider = {};
    report.manualPollObservation = {
      sequence: 1,
      commandIpcDispatched: true,
      workerBirthsCurrent: true,
      foregroundChildBirthObserved: false,
      postAuthority: true,
      pending: true,
      generationMatches: true,
    };
    report.manualPollCommitObservation = structuredClone(report.manualPollObservation);
    report.manualAcknowledgementObservation = {
      commitAccepted: true,
      canonicalAcknowledged: true,
      entryAndEventCorrelated: true,
      within120sMargin: true,
      enqueueToAckUpperBoundMs: 100000,
      requestStartToAcceptedMs: 100,
    };
  }
  return report;
}
function independent() {
  return {
    'native-model-tools/native-model-tools-proof.json': {
      passed: true,
      checks: Object.fromEntries(independentChecks.native.map((key) => [key, true])),
      provenance: {
        mobileHead: identity.candidate,
        expectedHead: identity.candidate,
        mobileTree: identity.tree,
        binarySha256: identity.native,
      },
    },
    'remote-proof.json': Object.fromEntries(
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
      ]
        .map((k) => [k, true])
        .concat([['ignoreHttpsErrors', false]]),
    ),
    'vitest.json': { success: true, numFailedTests: 0, numPassedTests: 148 },
    'cleanup-proof.json': { cleanupFailures: 0, stoppedProjectListeners: 4 },
    'project-isolation/project-isolation-proof.json': {
      passed: true,
      cleanupComplete: true,
      checks: Object.fromEntries(independentChecks.project.map((key) => [key, true])),
      provenance: { head: identity.candidate, tree: identity.tree, native: identity.native },
    },
  };
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function packets() {
  return Object.fromEntries(
    fullLanes.map((lane) => {
      const values =
        lane === 'independent'
          ? independent()
          : {
              'production-entrypoint/production-entrypoint-proof.json': production(lane),
              ...(['recovery', 'accept-steer'].includes(lane)
                ? {
                    [lane === 'recovery'
                      ? 'recovery-driver-cleanup.json'
                      : 'editing-driver-cleanup.json']: {
                      identity,
                      driverExited: true,
                      finalDriverVerified: true,
                      birth: { pid: 1, start: '1', boot: 'a'.repeat(36) },
                      cancelSent: false,
                    },
                  }
                : {}),
            };
      const reports = Object.fromEntries(
        Object.entries(values).map(([file, value]) => [file, JSON.stringify(value)]),
      );
      return [
        lane,
        {
          reports,
          receipt: {
            schemaVersion: 1,
            lane,
            identity: structuredClone(identity),
            passed: true,
            cleanupComplete: true,
            reports: Object.fromEntries(
              Object.entries(reports).map(([file, bytes]) => [file, sha(bytes)]),
            ),
          },
        },
      ];
    }),
  );
}
function mutateReport(packet, mutate) {
  const file = Object.keys(packet.reports)[0],
    value = JSON.parse(packet.reports[file]);
  mutate(value);
  packet.reports[file] = JSON.stringify(value);
  packet.receipt.reports[file] = sha(packet.reports[file]);
}
test('full selection mandates four lanes while smoke/preflight remain explicit single lanes', () => {
  assert.deepEqual(selectedLanes({ eventName: 'push', message: '[full-native]' }), {
    mode: 'full',
    lanes: [...fullLanes],
  });
  assert.deepEqual(selectedLanes({ eventName: 'pull_request' }).lanes, [...fullLanes]);
  assert.deepEqual(selectedLanes({ eventName: 'push', message: '[picker-smoke]' }), {
    mode: 'picker-smoke',
    lanes: ['picker-smoke'],
  });
  assert.deepEqual(selectedLanes({ eventName: 'push' }).lanes, ['preflight']);
  assert.throws(() =>
    selectedLanes({ eventName: 'push', message: '[full-native] [picker-smoke]' }),
  );
  assert.throws(() => productionLane('unknown'));
});
test('complete aggregation assigns all original assertions truthfully across fresh lanes', () => {
  const result = aggregateLanes(packets(), identity);
  assert.equal(result.passed, true);
  assert.equal(result.crossLaneEvidence, true);
  assert.deepEqual(result.fullAssertionOwners, fullAssertionOwners);
  assert.equal(result.genuineProvider, false);
  assert.equal(result.originalHookedEnabledHomeProven, false);
});
test('missing/extra/duplicate-labeled lanes, wrong run/candidate/tree/component pins and changed report bytes refuse full coverage', () => {
  for (const mutation of [
    (p) => {
      delete p.recovery;
    },
    (p) => {
      p.unexpected = p.recovery;
    },
    (p) => {
      p.recovery.receipt.lane = 'accept-steer';
    },
    ...Object.keys(identity).map((key) => (p) => {
      p.recovery.receipt.identity[key] = 'different';
    }),
    (p) => {
      p.recovery.reports[Object.keys(p.recovery.reports)[0]] += ' ';
    },
    (p) => {
      p.independent.receipt.cleanupComplete = false;
    },
  ]) {
    const p = packets();
    mutation(p);
    assert.throws(() => aggregateLanes(p, identity));
  }
});
test('every individual required assertion and source/browser/birth/recovery invariant remains mandatory', () => {
  for (const lane of fullLanes.filter((lane) => lane !== 'independent')) {
    for (const key of laneChecks[lane]) {
      const p = packets();
      mutateReport(p[lane], (d) => {
        delete d.checks[key];
      });
      assert.throws(() => aggregateLanes(p, identity), `${lane}/${key}`);
    }
  }
  for (const mutation of [
    (d) => {
      d.cleanupComplete = false;
    },
    (d) => {
      d.provenance.head = 'old';
    },
    (d) => {
      d.provenance.managerTree = 'wrong';
    },
    (d) => {
      d.nativeBinarySha256 = 'wrong';
    },
    (d) => {
      d.sourceInventory.signatureVerified = false;
    },
    (d) => {
      d.sourceInventory.captureGenerationMatchesLiveGeneration = false;
    },
    (d) => {
      d.recovery.captures[2] = d.recovery.captures[1];
    },
    (d) => {
      d.recovery.generations[3] = d.recovery.generations[2];
    },
    (d) => {
      d.recoveryHandoff.continuations = 2;
    },
    (d) => {
      d.recoveryHandoff.sameDriverBirth = false;
    },
    (d) => {
      d.recoveryHandoff.cancelled = true;
    },
  ]) {
    const p = packets();
    mutateReport(p.recovery, mutation);
    assert.throws(() => aggregateLanes(p, identity));
  }
  const p = packets();
  mutateReport(p['accept-steer'], (d) => {
    d.editBrowser.realPickerSteer = false;
  });
  assert.throws(() => aggregateLanes(p, identity));
});
const temporary = () => mkdtempSync(join(tmpdir(), 'live-proof-lanes-'));
test('private living handoff correlates exact birth and identity and releases only one continuation', async () => {
  const directory = temporary();
  const handoff = await openRecoveryHandoff({ directory, identity, onCancel() {} });
  try {
    const expected = handoff.snapshot();
    assert.equal(birthCurrent(expected.birth), true);
    const pending = handoff.boundary();
    for (const changed of [
      { ...expected, birth: { ...expected.birth, start: '0' } },
      { ...expected, identity: { ...identity, candidate: 'wrong' } },
    ])
      await assert.rejects(async () => handoffRequest(directory, 'continue', changed));
    assert.equal((await handoffRequest(directory, 'status', expected)).phase, 'ready');
    await handoffRequest(directory, 'continue', expected);
    await pending;
    assert.equal(handoff.snapshot().continuations, 1);
    await assert.rejects(handoffRequest(directory, 'continue', expected));
    await assert.rejects(handoffRequest(directory, 'replay', expected));
    await assert.rejects(handoffRequest(directory, 'canary-private-command', expected), (error) => {
      assert.equal(error.message, 'PROOF_HANDOFF_REFUSED');
      return !error.message.includes('canary-private');
    });
    assert.deepEqual(handoff.snapshot().birth, processBirth());
  } finally {
    await handoff.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('cancel and finite pause deadline drain the fixture callback and refuse continuation without retaining raw error text', async () => {
  for (const deadline of [false, true]) {
    const directory = temporary();
    let cancellations = 0;
    const handoff = await openRecoveryHandoff({
      directory,
      identity,
      pauseMs: deadline ? 20 : 1000,
      onCancel: async () => {
        cancellations++;
        await new Promise((done) => setTimeout(done, 5));
      },
    });
    const pending = handoff.boundary();
    pending.catch(() => {});
    try {
      if (!deadline) await handoffRequest(directory, 'cancel', handoff.snapshot());
      await assert.rejects(pending, /PROOF_CANCELLED/);
      await assert.rejects(handoffRequest(directory, 'continue', handoff.snapshot()));
      await handoff.close();
      assert.equal(cancellations, 1);
      assert.equal(JSON.parse(readFileSync(join(directory, 'final-driver.json'))).cancelled, true);
      assert.ok(
        !readFileSync(join(directory, 'final-driver.json'), 'utf8').includes('canary-private'),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
test('unsafe directory permissions, symlinked directory and replaced process birth cannot authorize a handoff', async () => {
  const directory = temporary(),
    link = directory + '-link';
  try {
    chmodSync(directory, 0o755);
    await assert.rejects(openRecoveryHandoff({ directory, identity, onCancel() {} }));
    chmodSync(directory, 0o700);
    symlinkSync(directory, link);
    await assert.rejects(openRecoveryHandoff({ directory: link, identity, onCancel() {} }));
    assert.equal(birthCurrent({ ...processBirth(), start: '0' }), false);
  } finally {
    rmSync(link, { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
test('an actual child retains the same observed birth through handoff and exits after cleanup', async () => {
  const directory = temporary();
  const url = new URL('./live-production-proof-lanes.mjs', import.meta.url).href;
  const code = `import {openRecoveryHandoff} from ${JSON.stringify(url)};
    const h=await openRecoveryHandoff({directory:${JSON.stringify(directory)},identity:${JSON.stringify(identity)},onCancel(){}});
    try { await h.boundary(); } finally { await h.close(); }`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    stdio: 'ignore',
  });
  const exited = new Promise((done) => child.once('close', done));
  const birth = processBirth(child.pid);
  try {
    const until = Date.now() + 5000;
    while (!existsSync(join(directory, 'driver.json')) && Date.now() < until)
      await new Promise((done) => setTimeout(done, 10));
    const expected = JSON.parse(readFileSync(join(directory, 'driver.json')));
    assert.deepEqual(expected.birth, birth);
    const status = await handoffRequest(directory, 'status', expected);
    assert.equal(status.phase, 'ready');
    await handoffRequest(directory, 'continue', expected);
    assert.equal(await exited, 0);
    assert.equal(birthCurrent(birth), false);
    const final = JSON.parse(readFileSync(join(directory, 'final-driver.json')));
    assert.deepEqual(final.birth, birth);
    assert.equal(final.continuations, 1);
    assert.equal(final.cancelled, false);
  } finally {
    if (birthCurrent(birth)) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('downloaded packet path keys and symlinked report parents refuse before any external read', () => {
  const directory = temporary();
  try {
    const packet = packets().recovery;
    writeFileSync(join(directory, 'lane-receipt.json'), JSON.stringify(packet.receipt));
    mkdirSync(join(directory, 'production-entrypoint'));
    for (const [file, bytes] of Object.entries(packet.reports))
      writeFileSync(join(directory, file), bytes);
    assert.equal(loadLanePacket(directory).receipt.lane, 'recovery');
    const invalid = structuredClone(packet.receipt);
    invalid.reports['../canary-private'] = '0'.repeat(64);
    writeFileSync(join(directory, 'lane-receipt.json'), JSON.stringify(invalid));
    assert.throws(() => loadLanePacket(directory));
    writeFileSync(join(directory, 'lane-receipt.json'), JSON.stringify(packet.receipt));
    rmSync(join(directory, 'production-entrypoint'), { recursive: true });
    symlinkSync(tmpdir(), join(directory, 'production-entrypoint'));
    assert.throws(() => loadLanePacket(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual child cancellation drains once and records cancelled exit; private socket can stay in the denied fixture root', async () => {
  const directory = temporary(),
    socketDirectory = temporary();
  const url = new URL('./live-production-proof-lanes.mjs', import.meta.url).href;
  const code = `import {openRecoveryHandoff} from ${JSON.stringify(url)};
    const h=await openRecoveryHandoff({directory:${JSON.stringify(directory)},socketDirectory:${JSON.stringify(socketDirectory)},identity:${JSON.stringify(identity)},onCancel(){}});
    try { await h.boundary(); } finally { await h.close(); }`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    stdio: 'ignore',
  });
  const exited = new Promise((done) => child.once('close', done));
  const birth = processBirth(child.pid);
  try {
    const until = Date.now() + 5000;
    while (!existsSync(join(directory, 'driver.json')) && Date.now() < until)
      await new Promise((done) => setTimeout(done, 10));
    const expected = JSON.parse(readFileSync(join(directory, 'driver.json')));
    assert.equal(expected.socketDirectory, socketDirectory);
    assert.equal(existsSync(join(directory, 'control.sock')), false);
    await handoffRequest(directory, 'cancel', expected);
    assert.equal(await exited, 1);
    assert.equal(birthCurrent(birth), false);
    const final = JSON.parse(readFileSync(join(directory, 'final-driver.json')));
    assert.deepEqual(final.birth, birth);
    assert.equal(final.continuations, 0);
    assert.equal(final.cancelled, true);
    assert.equal(existsSync(join(socketDirectory, 'control.sock')), false);
  } finally {
    if (birthCurrent(birth)) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
    rmSync(socketDirectory, { recursive: true, force: true });
  }
});

// Exercise the actual start/cleanup observers with a distinct blocked event loop.
async function blockedDriver(blockMs, callback, mode = 'handoff') {
  const directory = temporary();
  const url = new URL('./live-production-proof-lanes.mjs', import.meta.url).href;
  const code =
    mode === 'handoff'
      ? `
    import {openRecoveryHandoff} from ${JSON.stringify(url)};
    import {appendFileSync} from 'node:fs';
    const h=await openRecoveryHandoff({directory:${JSON.stringify(directory)},identity:${JSON.stringify(identity)},onCancel(){appendFileSync(${JSON.stringify(join(directory, 'cancel-count'))},'1');}});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${blockMs});
    try {await h.boundary();} finally {await h.close();}`
      : `
    import {createServer} from 'node:net';
    import {writeFileSync,chmodSync} from 'node:fs';
    import {processBirth} from ${JSON.stringify(url)};
    const directory=${JSON.stringify(directory)};
    const server=createServer(s=>s.on('data',()=>s.end('canary-private-raw-response\\n')));
    await new Promise(done=>server.listen(directory+'/control.sock',done));
    chmodSync(directory+'/control.sock',0o600);
    writeFileSync(directory+'/driver.json',JSON.stringify({schemaVersion:1,identity:${JSON.stringify(identity)},birth:processBirth(),socketDirectory:directory,phase:'setup',continuations:0,cancelled:false,phaseTimings:{setupMs:0,pausedMs:0,recoveryMs:0}}),{mode:0o600});`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    stdio: 'ignore',
  });
  const exited = new Promise((done) => child.once('close', done));
  const birth = processBirth(child.pid);
  writeFileSync(join(directory, 'launched.json'), JSON.stringify({ identity, birth }), {
    mode: 0o600,
  });
  try {
    const until = Date.now() + 5000;
    while (!existsSync(join(directory, 'driver.json')) && Date.now() < until)
      await new Promise((done) => setTimeout(done, 10));
    assert.ok(existsSync(join(directory, 'driver.json')));
    await callback({ directory, birth, exited });
  } finally {
    if (birthCurrent(birth)) child.kill('SIGTERM');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
}
test('top-level setup observer retries transient status beyond 2.5s without continuation and cleanup drains once', async () => {
  await blockedDriver(3300, async ({ directory, birth, exited }) => {
    const state = await observeRecoveryPhase(directory, (s) => s.phase === 'ready', 6000, identity);
    assert.equal(state.continuations, 0);
    assert.deepEqual(state.birth, birth);
    const observed = JSON.parse(readFileSync(join(directory, 'observation.json')));
    assert.ok(observed.transientFailures >= 1);
    assert.ok(observed.elapsedMs >= 2500 && observed.elapsedMs < 6000);
    const cleanup = await settleRecoveryDriver(directory, identity, 5000);
    await exited;
    assert.equal(cleanup.driverExited, true);
    assert.equal(readFileSync(join(directory, 'cancel-count'), 'utf8'), '1');
    const final = JSON.parse(readFileSync(join(directory, 'final-driver.json')));
    assert.equal(final.continuations, 0);
    assert.equal(final.cancelled, true);
    assert.ok(!JSON.stringify(cleanup).includes(directory));
  });
});
test('top-level cleanup retries ambiguous idempotent cancel after a real blocked child and never continues', async () => {
  await blockedDriver(3300, async ({ directory, exited }) => {
    const cleanup = await settleRecoveryDriver(directory, identity, 6000);
    await exited;
    assert.equal(cleanup.driverExited, true);
    assert.ok(cleanup.transientFailures >= 1);
    assert.equal(cleanup.cancelAttempted, true);
    assert.equal(readFileSync(join(directory, 'cancel-count'), 'utf8'), '1');
    assert.equal(JSON.parse(readFileSync(join(directory, 'final-driver.json'))).continuations, 0);
  });
});
test('observation and cleanup each retain their original total deadline despite blocked RPC', async () => {
  for (const operation of ['observe', 'cleanup'])
    await blockedDriver(3300, async ({ directory }) => {
      const began = performance.now();
      await assert.rejects(
        operation === 'observe'
          ? observeRecoveryPhase(directory, (s) => s.phase === 'ready', 150, identity)
          : settleRecoveryDriver(directory, identity, 150),
        operation === 'observe' ? /PROOF_DRIVER_PHASE_DEADLINE/ : /PROOF_DRIVER_CLEANUP_UNVERIFIED/,
      );
      assert.ok(performance.now() - began < 700);
      const diagnostic = JSON.parse(
        readFileSync(
          join(directory, operation === 'observe' ? 'observation.json' : 'cleanup.json'),
        ),
      );
      assert.equal(diagnostic.driverExited, false);
      assert.ok(diagnostic.failure);
    });
});
test('fresh metadata mutation during transient observation refuses before another RPC; malformed response is never retried', async () => {
  await blockedDriver(3300, async ({ directory }) => {
    const timer = setTimeout(() => {
      const path = join(directory, 'driver.json'),
        data = JSON.parse(readFileSync(path));
      data.identity.candidate = 'canary-private-mutation';
      writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
    }, 50);
    try {
      await assert.rejects(observeRecoveryPhase(directory, () => false, 6000, identity));
      const diagnostic = JSON.parse(readFileSync(join(directory, 'observation.json')));
      assert.equal(diagnostic.transientFailures, 0);
      assert.ok(!JSON.stringify(diagnostic).includes('canary-private'));
    } finally {
      clearTimeout(timer);
    }
  });
  await blockedDriver(
    0,
    async ({ directory }) => {
      await assert.rejects(
        observeRecoveryPhase(directory, () => false, 3000, identity),
        /PROOF_HANDOFF_REFUSED/,
      );
      const diagnostic = JSON.parse(readFileSync(join(directory, 'observation.json')));
      assert.equal(diagnostic.transientFailures, 0);
      assert.ok(!JSON.stringify(diagnostic).includes('canary-private'));
      await assert.rejects(
        settleRecoveryDriver(directory, identity, 3000),
        /PROOF_HANDOFF_REFUSED/,
      );
      assert.ok(!readFileSync(join(directory, 'cleanup.json'), 'utf8').includes('canary-private'));
    },
    'malformed',
  );
});

test('top-level cleanup rejects changed launched birth and malformed retained observation without leaking private content', async () => {
  await blockedDriver(3300, async ({ directory }) => {
    const path = join(directory, 'launched.json'),
      launched = JSON.parse(readFileSync(path));
    launched.birth.start = '0';
    writeFileSync(path, JSON.stringify(launched), { mode: 0o600 });
    await assert.rejects(settleRecoveryDriver(directory, identity, 500), /PROOF_BIRTH_CHANGED/);
    const diagnostic = JSON.parse(readFileSync(join(directory, 'cleanup.json')));
    assert.equal(diagnostic.cancelAttempted, false);
  });
  await blockedDriver(0, async ({ directory, exited }) => {
    await observeRecoveryPhase(directory, (s) => s.phase === 'ready', 2000, identity);
    const path = join(directory, 'observation.json'),
      observed = JSON.parse(readFileSync(path));
    observed.phase = 'canary-private-observation';
    writeFileSync(path, JSON.stringify(observed), { mode: 0o600 });
    await assert.rejects(settleRecoveryDriver(directory, identity, 3000), /PROOF_EVIDENCE_INVALID/);
    await exited;
    const cleanup = readFileSync(join(directory, 'cleanup.json'), 'utf8');
    assert.equal(JSON.parse(cleanup).driverExited, true);
    assert.ok(!cleanup.includes('canary-private'));
  });
});

function diagnosticPicker() {
  const report = production('accept-steer');
  delete report.productionLane;
  report.proofKind = 'actual-picker-current-independent-diagnostic';
  report.pickerDiagnostic = {
    mode: 'picker-diagnostic',
    diagnosticOnly: true,
    fullExactCandidateStillRequired: true,
    identity: structuredClone(identity),
  };
  report.disposableTreeRemoved = true;
  report.checks = Object.fromEntries(diagnosticPickerChecks.map((key) => [key, true]));
  report.editBrowser = {
    ...report.editBrowser,
    pickerSmoke: true,
    realPickerSteer: false,
    realPickerManualApply: false,
    realPickerDiscard: false,
    actualTabHiddenBeyondEightSeconds: false,
  };
  report.laneCanonicalEvents = report.laneCanonicalEvents.slice(0, 2);
  report.pickerObservations = ['before-accept', 'after-accept', 'after-accept-ack'].map(
    (boundary) => ({
      boundary,
      available: true,
      navigationCount: 3,
      pageChatInDocument: true,
      globalBar: { present: true },
      pageChat: { present: true },
    }),
  );
  report.startAdmissionElapsedMs = 100;
  report.eventAuthorityTimings = [
    { phase: 'event-turn', grantedAfterMs: 1, elapsedMs: 2, completed: true },
    { phase: 'canonical-poll', grantedAfterMs: 1, elapsedMs: 2, completed: true },
  ];
  for (const [field, labels] of [
    [
      'admissionVerificationTimings',
      [
        'admission-inspection',
        'admission-catalog-context',
        'admission-catalog-org',
        'admission-config',
        'admission-thread',
        'admission-account',
        'admission-resources',
      ],
    ],
    [
      'policyVerificationTimings',
      [
        'policy-total',
        'policy-manager-verify',
        'policy-source-observer',
        'policy-agents-verify',
        'policy-local-installation',
      ],
    ],
  ])
    report[field] = {
      calls: labels.map((operation) => ({
        operation,
        result: 'completed',
        groupId: 1,
        startedAfterMs: 0,
        elapsedMs: 1,
      })),
      counters: Object.fromEntries(
        labels.map((label) => [label, { started: 1, completed: 1, failed: 0, totalMs: 1 }]),
      ),
    };
  return report;
}
function diagnosticPackets() {
  const p = { independent: packets().independent };
  const file = 'production-entrypoint/production-entrypoint-proof.json';
  const bytes = JSON.stringify(diagnosticPicker());
  p['picker-diagnostic'] = {
    reports: { [file]: bytes },
    receipt: {
      schemaVersion: 1,
      lane: 'picker-diagnostic',
      identity: structuredClone(identity),
      passed: true,
      cleanupComplete: true,
      reports: { [file]: sha(bytes) },
    },
  };
  for (const packet of Object.values(p))
    Object.assign(packet.receipt, {
      mode: 'picker-diagnostic',
      diagnosticOnly: true,
      fullExactCandidateStillRequired: true,
    });
  return p;
}

test('explicit picker diagnostic mandates fresh independent plus picker lanes and cannot count as full', () => {
  assert.deepEqual(selectedLanes({ eventName: 'push', message: '[picker-diagnostic]' }), {
    mode: 'picker-diagnostic',
    lanes: [...diagnosticLanes],
  });
  assert.deepEqual(
    selectedLanes({ eventName: 'workflow_dispatch', preflight: true, pickerDiagnostic: true })
      .lanes,
    [...diagnosticLanes],
  );
  for (const message of ['[picker-diagnostic] [picker-smoke]', '[picker-diagnostic] [full-native]'])
    assert.throws(() => selectedLanes({ eventName: 'push', message }));
  const p = diagnosticPackets(),
    result = aggregateDiagnostic(p, identity);
  assert.equal(result.passed, true);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.fullAcceptance, false);
  assert.equal(result.fullExactCandidateStillRequired, true);
  assert.equal(result.fullAssertionOwners, undefined);
  assert.deepEqual(result.unprovenActions, [
    'steer',
    'manual-apply',
    'discard',
    'background',
    'recovery',
  ]);
  assert.throws(() => aggregateLanes(p, identity));
  const full = packets();
  full.independent = p.independent;
  assert.throws(() => aggregateLanes(full, identity));
  assert.throws(() => aggregateDiagnostic(packets(), identity));
});

test('diagnostic aggregation refuses missing extra relabeled unbound or changed artifacts and every identity pin', () => {
  const mutations = [
    (p) => {
      delete p.independent;
    },
    (p) => {
      p.extra = p.independent;
    },
    (p) => {
      p['picker-diagnostic'].receipt.lane = 'independent';
    },
    (p) => {
      delete p.independent.receipt.mode;
    },
    (p) => {
      p.independent.receipt.cleanupComplete = false;
    },
    (p) => {
      p.independent.receipt.diagnosticOnly = false;
    },
    (p) => {
      p['picker-diagnostic'].receipt.fullExactCandidateStillRequired = false;
    },
    (p) => {
      p['picker-diagnostic'].reports['production-entrypoint/production-entrypoint-proof.json'] +=
        ' ';
    },
  ];
  for (const key of Object.keys(identity))
    mutations.push((p) => {
      p.independent.receipt.identity[key] = 'changed';
    });
  for (const mutate of mutations) {
    const p = diagnosticPackets();
    mutate(p);
    assert.throws(() => aggregateDiagnostic(p, identity));
  }
  for (const [category, file] of [
    ['native', 'native-model-tools/native-model-tools-proof.json'],
    ['project', 'project-isolation/project-isolation-proof.json'],
    ['remote', 'remote-proof.json'],
  ]) {
    for (const key of independentChecks[category]) {
      const p = diagnosticPackets(),
        packet = p.independent,
        report = JSON.parse(packet.reports[file]);
      if (category === 'remote') report[key] = false;
      else report.checks[key] = false;
      packet.reports[file] = JSON.stringify(report);
      packet.receipt.reports[file] = sha(packet.reports[file]);
      assert.throws(() => aggregateDiagnostic(p, identity));
    }
  }
});

test('diagnostic picker requires every original smoke assertion and actual canonical after-ack observations/timings', () => {
  const mutations = [
    (report) => {
      report.independentEvidenceReuse = { baseline: 'historical' };
    },
    (report) => {
      report.provenance.tree = 'changed';
    },
    (report) => {
      report.sourceInventory.signatureVerified = false;
    },
    (report) => {
      report.disposableTreeRemoved = false;
    },
    (report) => {
      report.editBrowser.realPickerSteer = true;
    },
    (report) => {
      report.pickerObservations.pop();
    },
    (report) => {
      report.pickerObservations[2].available = false;
    },
    (report) => {
      report.laneCanonicalEvents[1].stage = 'applied';
    },
    (report) => {
      report.startAdmissionElapsedMs = 0;
    },
    (report) => {
      report.eventAuthorityTimings[0].completed = false;
    },
    (report) => {
      delete report.admissionVerificationTimings.counters['admission-catalog-org'];
    },
    (report) => {
      report.admissionVerificationTimings.calls = [];
    },
    (report) => {
      report.pickerObservations[2].pageChat = {};
    },
    (report) => {
      report.policyVerificationTimings.counters['policy-total'].started++;
    },
    ...diagnosticPickerChecks.map((key) => (report) => {
      delete report.checks[key];
    }),
  ];
  for (const mutate of mutations) {
    const p = diagnosticPackets();
    mutateReport(p['picker-diagnostic'], mutate);
    assert.throws(() => aggregateDiagnostic(p, identity));
  }
});

test('diagnostic receipts round-trip bounded files and retain exact-candidate cleanup identity', () => {
  const directory = temporary();
  try {
    for (const [lane, packet] of Object.entries(diagnosticPackets())) {
      const root = join(directory, lane);
      for (const [file, bytes] of Object.entries(packet.reports)) {
        mkdirSync(join(root, file, '..'), { recursive: true });
        writeFileSync(join(root, file), bytes);
      }
      writeLaneReceipt(lane, root, identity, 'picker-diagnostic');
      const loaded = loadLanePacket(root);
      assert.equal(loaded.receipt.diagnosticOnly, true);
      packet.receipt = loaded.receipt;
      packet.reports = loaded.reports;
    }
    const loaded = Object.fromEntries(
      diagnosticLanes.map((lane) => [lane, loadLanePacket(join(directory, lane))]),
    );
    assert.equal(aggregateDiagnostic(loaded, identity).passed, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('diagnostic CLI aggregates both exact-candidate receipts and emits only diagnostic failure for missing peers', () => {
  const directory = temporary();
  const entrypoint = new URL('./live-production-proof-lanes.mjs', import.meta.url);
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const fakeGit = join(bin, 'git');
    writeFileSync(
      fakeGit,
      `#!${process.execPath}\nconst args=process.argv.slice(2);if(args.length!==2||args[0]!=='rev-parse')process.exit(1);if(args[1]==='HEAD')console.log('${identity.candidate}');else if(args[1]==='HEAD^{tree}')console.log('${identity.tree}');else process.exit(1);\n`,
    );
    chmodSync(fakeGit, 0o700);
    const root = join(directory, 'lanes');
    for (const [lane, packet] of Object.entries(diagnosticPackets())) {
      for (const [file, bytes] of Object.entries(packet.reports)) {
        mkdirSync(join(root, lane, file, '..'), { recursive: true });
        writeFileSync(join(root, lane, file), bytes);
      }
      writeFileSync(join(root, lane, 'lane-receipt.json'), JSON.stringify(packet.receipt));
    }
    const output = join(directory, 'aggregate.json');
    const options = {
      cwd: directory,
      env: {
        PATH: bin + ':/usr/bin:/bin',
        HOME: directory,
        LIVE_PROOF_EXPECTED_HEAD: identity.candidate,
        GITHUB_RUN_ID: identity.runId,
      },
      stdio: 'pipe',
    };
    execFileSync(
      process.execPath,
      [entrypoint.pathname, 'aggregate-diagnostic', root, output],
      options,
    );
    const result = JSON.parse(readFileSync(output));
    assert.equal(result.passed, true);
    assert.equal(result.diagnosticOnly, true);
    assert.equal(result.fullAcceptance, false);
    rmSync(join(root, 'independent'), { recursive: true });
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [entrypoint.pathname, 'aggregate-diagnostic', root, output],
        options,
      ),
    );
    const failed = JSON.parse(readFileSync(output));
    assert.equal(failed.passed, false);
    assert.equal(failed.cleanupComplete, false);
    assert.equal(failed.diagnosticOnly, true);
    assert.equal(failed.fullAcceptance, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function terminalInterruptedPicker() {
  const report = diagnosticPicker();
  // Exact real run39090977856 authority rows, including the final observation.
  report.eventAuthorityTimings = [
    { phase: 'canonical-poll', grantedAfterMs: 69179, elapsedMs: 71078, completed: true },
    { phase: 'event-turn', grantedAfterMs: 48041, elapsedMs: 97972, completed: true },
    { phase: 'canonical-poll', grantedAfterMs: 45425, elapsedMs: 47709, completed: true },
    { phase: 'canonical-poll', grantedAfterMs: null, elapsedMs: 3490, completed: false },
  ];
  report.cleanupStage = 'settled';
  report.cleanupOperations = [
    'controller-close',
    'signed-revoke',
    'poll-drain',
    'poll-settle',
    'owning-abort',
  ].map((operation) => ({ operation, result: 'completed' }));
  report.nativeLaunchLifetimes = [
    { capturedOwner: true, exitCode: 0, signal: null, exitVerified: true, treeFailures: 0 },
  ];
  report.cleanupProjectClosure = ['helper', 'devserver'].map((role) => ({
    role,
    namespaceExited: true,
    pipeDescriptorsClosed: true,
  }));
  return report;
}
test('real terminal nonauthorizing poll shape is preserved and classified without claiming its cause', () => {
  const report = terminalInterruptedPicker();
  const original = structuredClone(report);
  assert.equal(validateDiagnosticPicker(report, identity), 'terminal-nonauthorizing-interruption');
  assert.deepEqual(report, original);
  const packets = diagnosticPackets();
  mutateReport(packets['picker-diagnostic'], (value) => Object.assign(value, report));
  const aggregate = aggregateDiagnostic(packets, identity);
  assert.equal(aggregate.authorityObservation, 'terminal-nonauthorizing-interruption');
  assert.equal(aggregate.fullAcceptance, false);
  assert.equal(
    aggregateDiagnostic(diagnosticPackets(), identity).authorityObservation,
    'all-observed-boundaries-completed',
  );
});
test('terminal poll exception refuses event failures, granted authority, early or multiple failures and missing positive closure', () => {
  const mutations = [
    (r) => {
      r.eventAuthorityTimings[3].phase = 'event-turn';
    },
    (r) => {
      r.eventAuthorityTimings[3].grantedAfterMs = 0;
    },
    (r) => {
      r.eventAuthorityTimings[3].elapsedMs = -1;
    },
    (r) => {
      r.eventAuthorityTimings[3].completed = undefined;
    },
    (r) => {
      r.eventAuthorityTimings[1].completed = false;
      r.eventAuthorityTimings[1].grantedAfterMs = null;
    },
    (r) => {
      r.eventAuthorityTimings.unshift(structuredClone(r.eventAuthorityTimings[3]));
    },
    (r) => {
      r.eventAuthorityTimings.push(structuredClone(r.eventAuthorityTimings[3]));
    },
    (r) => {
      r.eventAuthorityTimings = r.eventAuthorityTimings.filter((v) => v.phase !== 'event-turn');
    },
    (r) => {
      r.eventAuthorityTimings = r.eventAuthorityTimings.filter(
        (v) => !(v.phase === 'canonical-poll' && v.completed),
      );
    },
    (r) => {
      r.cleanupComplete = false;
    },
    (r) => {
      r.disposableTreeRemoved = false;
    },
    (r) => {
      r.cleanupStage = 'mobile';
    },
    (r) => {
      r.shutdownFailure = 'LIVE_CLEANUP_REQUIRED';
    },
    (r) => {
      r.disposableCleanupFailure = 'OWNED_PROOF_CLEANUP_FAILED';
    },
    (r) => {
      r.cleanupOperations[0].result = 'failed';
    },
    (r) => {
      r.cleanupOperations.push({ operation: 'poll-settle', result: 'started' });
    },
    (r) => {
      r.nativeLaunchLifetimes[0].exitVerified = false;
    },
    (r) => {
      r.nativeLaunchLifetimes[0].exitCode = null;
    },
    (r) => {
      r.nativeLaunchLifetimes[0].signal = 'SIGTERM';
    },
    (r) => {
      r.nativeLaunchLifetimes[0].treeFailures = 1;
    },
    (r) => {
      r.nativeLaunchLifetimes = [];
    },
    (r) => {
      r.nativeLaunchLifetimes.push(structuredClone(r.nativeLaunchLifetimes[0]));
    },
    (r) => {
      r.cleanupProjectClosure.pop();
    },
    (r) => {
      r.cleanupProjectClosure[1].role = 'helper';
    },
    (r) => {
      r.provenance.tree = 'changed';
    },
    (r) => {
      r.sourceInventory.signatureVerified = false;
    },
    (r) => {
      r.laneCanonicalEvents[1].stage = 'applied';
    },
    (r) => {
      r.pickerDiagnostic.identity.manager = 'changed';
    },
    ...['controller-close', 'signed-revoke', 'poll-drain', 'poll-settle', 'owning-abort'].map(
      (op) => (r) => {
        r.cleanupOperations = r.cleanupOperations.filter((v) => v.operation !== op);
      },
    ),
    ...['helper', 'devserver'].flatMap((role) =>
      ['namespaceExited', 'pipeDescriptorsClosed'].map((key) => (r) => {
        r.cleanupProjectClosure.find((v) => v.role === role)[key] = false;
      }),
    ),
    ...diagnosticPickerChecks.map((key) => (r) => {
      r.checks[key] = false;
    }),
  ];
  for (const mutate of mutations) {
    const report = terminalInterruptedPicker();
    mutate(report);
    assert.throws(() => validateDiagnosticPicker(report, identity));
  }
  const packets = diagnosticPackets();
  mutateReport(packets['picker-diagnostic'], (r) => Object.assign(r, terminalInterruptedPicker()));
  packets['picker-diagnostic'].reports['production-entrypoint/production-entrypoint-proof.json'] +=
    ' ';
  assert.throws(() => aggregateDiagnostic(packets, identity), /PROOF_REPORT_CHANGED/);
});

test('full lanes retain real continuity and exact dispatched-poll/manual120s observations as mandatory evidence', () => {
  const mutations = [
    [
      'accept-steer',
      (r) => {
        r.editingContinuity.phaseB.postResumeContinuity.visibleChrome = false;
      },
    ],
    [
      'accept-steer',
      (r) => {
        r.editingContinuity.phaseB.postResumeContinuity.freshDocumentHelperConnected = false;
      },
    ],
    [
      'accept-steer',
      (r) => {
        r.editingContinuity.phaseB.postResumeContinuity.acceptedHeading = false;
      },
    ],
    [
      'accept-steer',
      (r) => {
        r.editingContinuity.phaseB.postResumeContinuity.elapsedMs = 300000;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualPollObservation.commandIpcDispatched = false;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualPollObservation.workerBirthsCurrent = false;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualPollCommitObservation.pending = false;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualPollCommitObservation.sequence++;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualPollObservation.foregroundChildBirthObserved = true;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualAcknowledgementObservation.entryAndEventCorrelated = false;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualAcknowledgementObservation.enqueueToAckUpperBoundMs = 120001;
      },
    ],
    [
      'manual-discard',
      (r) => {
        r.manualAcknowledgementObservation.requestStartToAcceptedMs = 100001;
      },
    ],
  ];
  for (const [lane, mutate] of mutations) {
    const p = packets();
    mutateReport(p[lane], mutate);
    assert.throws(() => aggregateLanes(p, identity));
  }
});

test('independent-only selects exactly the existing independent lane without production editing or recovery', () => {
  for (const selection of [
    { eventName: 'push', message: '[independent-only]' },
    { eventName: 'workflow_dispatch', independentOnly: true, preflight: true },
  ])
    assert.deepEqual(selectedLanes(selection), {
      mode: 'independent-only',
      lanes: ['independent'],
    });
});

test('independent-only receipt retains complete evidence and cannot satisfy either acceptance aggregate', () => {
  const root = temporary();
  try {
    const reports = independent();
    const save = () => {
      for (const [file, value] of Object.entries(reports)) {
        mkdirSync(join(root, file, '..'), { recursive: true });
        writeFileSync(join(root, file), JSON.stringify(value));
      }
    };
    save();
    const receipt = writeLaneReceipt('independent', root, identity, 'independent-only');
    assert.equal(receipt.partialL11AdmissionEvidence, true);
    assert.equal(receipt.fullExactCandidateStillRequired, true);
    assert.equal(receipt.mode, 'independent-only');
    const loaded = loadLanePacket(root);
    assert.deepEqual(loaded.receipt, receipt);
    for (const [file, bytes] of Object.entries(loaded.reports))
      assert.equal(sha(bytes), receipt.reports[file]);
    const full = packets();
    full.independent = loaded;
    assert.throws(() => aggregateLanes(full, identity));
    const diagnostic = diagnosticPackets();
    diagnostic.independent = loaded;
    assert.throws(() => aggregateDiagnostic(diagnostic, identity));
    assert.throws(() => writeLaneReceipt('accept-steer', root, identity, 'independent-only'));
    assert.throws(() => writeLaneReceipt('independent', root, identity, 'unknown'));
    for (const mutate of [
      () => {
        reports[
          'native-model-tools/native-model-tools-proof.json'
        ].checks.modelPrivateReadNeverReachedProvider = false;
      },
      () => {
        reports['native-model-tools/native-model-tools-proof.json'].provenance.mobileHead =
          'c'.repeat(40);
      },
      () => {
        reports['native-model-tools/native-model-tools-proof.json'].provenance.mobileTree =
          'c'.repeat(40);
      },
      () => {
        reports['native-model-tools/native-model-tools-proof.json'].provenance.binarySha256 =
          'c'.repeat(64);
      },
      () => {
        reports['cleanup-proof.json'].cleanupFailures = 1;
      },
      () => {
        reports['project-isolation/project-isolation-proof.json'].cleanupComplete = false;
      },
    ]) {
      const clean = structuredClone(reports);
      mutate();
      save();
      assert.throws(() => writeLaneReceipt('independent', root, identity, 'independent-only'));
      for (const key of Object.keys(reports)) reports[key] = clean[key];
    }
    save();
    rmSync(join(root, 'cleanup-proof.json'));
    assert.throws(() => writeLaneReceipt('independent', root, identity, 'independent-only'));
    const changed = structuredClone(loaded);
    changed.reports['cleanup-proof.json'] += '\n';
    delete changed.receipt.mode;
    const changedFull = packets();
    changedFull.independent = changed;
    assert.throws(() => aggregateLanes(changedFull, identity), /PROOF_REPORT_CHANGED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixed editing milestone scope requires explicit full push and selects exactly the two unchanged editing lanes', () => {
  assert.deepEqual(selectedLanes({ eventName: 'push', message: '[full-native] [editing-lanes]' }), {
    mode: 'full',
    lanes: ['accept-steer', 'manual-discard'],
    verificationScope: 'editing-only',
  });
  for (const selection of [
    { eventName: 'push', message: '[editing-lanes]' },
    { eventName: 'pull_request', message: '[full-native] [editing-lanes]' },
    { eventName: 'workflow_dispatch', message: '[full-native] [editing-lanes]' },
    { eventName: 'push', message: '[full-native] [editing-lanes]', preflight: true },
    { eventName: 'push', message: '[full-native] [editing-lanes] [picker-smoke]' },
    { eventName: 'push', message: '[full-native] [editing-lanes] [independent-only]' },
  ])
    assert.throws(() => selectedLanes(selection));
  assert.deepEqual(selectedLanes({ eventName: 'push', message: '[full-native]' }), {
    mode: 'full',
    lanes: [...fullLanes],
  });
  assert.deepEqual(selectedLanes({ eventName: 'push' }), {
    mode: 'preflight',
    lanes: ['preflight'],
  });
});

test('editing milestone receipts retain complete identity/digests/cleanup and never substitute for full coverage', () => {
  const directory = temporary();
  try {
    for (const lane of ['accept-steer', 'manual-discard']) {
      const root = join(directory, lane),
        file = 'production-entrypoint/production-entrypoint-proof.json';
      mkdirSync(join(root, 'production-entrypoint'), { recursive: true });
      const value = production(lane);
      const save = () => writeFileSync(join(root, file), JSON.stringify(value));
      if (lane === 'accept-steer')
        writeFileSync(
          join(root, 'editing-driver-cleanup.json'),
          packets()[lane].reports['editing-driver-cleanup.json'],
        );
      save();
      const receipt = writeLaneReceipt(lane, root, identity, 'full', 'editing-only');
      assert.deepEqual(receipt.identity, identity);
      assert.equal(receipt.verificationScope, 'editing-only');
      assert.equal(receipt.partialL11EditingEvidence, true);
      assert.equal(receipt.fullExactCandidateStillRequired, true);
      assert.equal(receipt.cleanupComplete, true);
      const packet = loadLanePacket(root);
      assert.equal(sha(packet.reports[file]), receipt.reports[file]);
      const complete = packets();
      complete[lane] = packet;
      assert.throws(() => aggregateLanes(complete, identity));
      value.provenance.head = 'c'.repeat(40);
      save();
      assert.throws(() => writeLaneReceipt(lane, root, identity, 'full', 'editing-only'));
      value.provenance.head = identity.candidate;
      value.cleanupComplete = false;
      save();
      assert.throws(() => writeLaneReceipt(lane, root, identity, 'full', 'editing-only'));
      value.cleanupComplete = true;
      save();
      assert.throws(() =>
        writeLaneReceipt(lane, root, identity, 'picker-diagnostic', 'editing-only'),
      );
      assert.throws(() => writeLaneReceipt(lane, root, identity, 'full', 'arbitrary-lanes'));
    }
    assert.throws(() => writeLaneReceipt('recovery', directory, identity, 'full', 'editing-only'));
    assert.throws(() =>
      writeLaneReceipt('independent', directory, identity, 'full', 'editing-only'),
    );
    const workflow = readFileSync(
      new URL('../.github/workflows/live-caddy-proof.yml', import.meta.url),
      'utf8',
    );
    assert.ok(
      workflow.includes(
        "if: always() && needs.proof-selection.outputs.mode == 'full' && needs.proof-selection.outputs.verification-scope != 'editing-only'",
      ),
    );
    assert.ok(
      workflow.includes(
        'LIVE_PROOF_VERIFICATION_SCOPE: ${{ needs.proof-selection.outputs.verification-scope }}',
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual omits unexecuted confinement claims while exact-current accept owner remains mandatory', () => {
  const result = aggregateLanes(packets(), identity);
  for (const check of modelConfinementChecks) {
    assert.deepEqual(result.fullAssertionOwners[check], ['accept-steer']);
    assert.ok(!laneChecks['manual-discard'].includes(check));
    assert.ok(laneChecks['accept-steer'].includes(check));
    assert.ok(diagnosticPickerChecks.includes(check));
    for (const mutation of [
      (report) => {
        report.checks[check] = true;
      },
      (report) => {
        report.checks[check] = false;
      },
    ]) {
      const values = packets();
      mutateReport(values['manual-discard'], mutation);
      assert.throws(() => aggregateLanes(values, identity));
    }
    const values = packets();
    mutateReport(values['accept-steer'], (report) => {
      delete report.checks[check];
    });
    assert.throws(() => aggregateLanes(values, identity));
  }
  for (const mutate of [
    (report) => {
      report.modelWorkload = 'owning-edit-and-confinement';
    },
    (report) => {
      report.provider.contextProtocol = { state: 'completed' };
    },
    (report) => {
      report.provider.spawnResponse = {};
    },
    (report) => {
      report.nativeActivity = { files: 2 };
    },
    (report) => {
      report.manualAcknowledgementObservation.enqueueToAckUpperBoundMs = 120001;
    },
    (report) => {
      report.laneCanonicalEvents[0].history.pop();
    },
  ]) {
    const values = packets();
    mutateReport(values['manual-discard'], mutate);
    assert.throws(() => aggregateLanes(values, identity));
  }
});

test('editing anchor is shared across processes and refuses changed boot or monotonic origin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'editing-clock-'));
  const path = join(directory, 'anchor.json');
  const original = { boot: processBirth().boot, monotonicNs: process.hrtime.bigint().toString() };
  try {
    writeFileSync(path, JSON.stringify(original), { mode: 0o600 });
    assert.deepEqual(readEditingAnchor(path), original);
    const sampled = BigInt(
      execFileSync(process.execPath, ['-p', 'process.hrtime.bigint().toString()'], {
        encoding: 'utf8',
      }).trim(),
    );
    assert.ok(sampled >= BigInt(original.monotonicNs));
    writeFileSync(path, JSON.stringify({ ...original, monotonicNs: (sampled + 1n).toString() }));
    assert.throws(() => readEditingAnchor(path, original));
    writeFileSync(path, JSON.stringify({ ...original, boot: '0'.repeat(36) }));
    assert.throws(() => readEditingAnchor(path), /BIRTH_CHANGED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('explicit editing recovery requires both original and new-fence phases without replay or claimed uninterrupted continuity', () => {
  validateEditingContinuity(production('accept-steer'));
  const mutations = [
    (p) => {
      p.oldCookieDeniedStatus = 500;
    },
    (p) => {
      p.oldCookieDeniedCode = 'LIVE_AUTH_UNAVAILABLE';
    },
    ...['phaseATotalMs', 'phaseBTotalMs', 'actionFinishedOffsetMs', 'cleanupFinishedOffsetMs'].map(
      (key) => (p) => {
        p[key] = 2700001;
      },
    ),
    (p) => {
      p.kind = 'uninterrupted';
    },
    (p) => {
      p.phaseAllocationMs[0]++;
    },
    (p) => {
      p.resumeDispatches = 0;
    },
    (p) => {
      p.resumeDispatches = 2;
    },
    (p) => {
      p.recoveryGeneration = p.originalGeneration;
    },
    (p) => {
      p.resumedGeneration = p.recoveryGeneration;
    },
    (p) => {
      p.phaseA = p.phaseB;
    },
    (p) => {
      p.phaseB = p.phaseA;
    },
    (p) => {
      p.phaseA.realPickerGenerateAccept = false;
    },
    (p) => {
      p.phaseA.realPickerSteer = true;
    },
    (p) => {
      p.phaseB.realPickerGenerateAccept = true;
    },
    (p) => {
      p.phaseB.observedGeneration = p.originalGeneration;
    },
    (p) => {
      p.phaseB.exchangePosts = 2;
    },
    (p) => {
      p.canonicalGenerations.accept = p.resumedGeneration;
    },
    (p) => {
      p.canonicalGenerations.steer = p.originalGeneration;
    },
    (p) => {
      p.phaseB.postResumeContinuity.visibleChrome = false;
    },
    (p) => {
      p.phaseB.postResumeContinuity.elapsedMs = 30001;
    },
    ...[
      'originalNativeSurvived',
      'genuineBrowserClosed',
      'newSignedCapture',
      'sameNativeThreadSelection',
      'noModelOrSourceReplay',
      'oldCookieDenied',
      'staleGrantDenied',
    ].map((key) => (p) => {
      p[key] = false;
    }),
  ];
  for (const mutate of mutations) {
    const report = production('accept-steer');
    mutate(report.editingContinuity);
    assert.throws(() => validateEditingContinuity(report));
  }
  for (const key of ['sameDriverBirth', 'cancelled', 'continuations']) {
    const report = production('accept-steer');
    report.recoveryHandoff[key] = key === 'cancelled' ? true : key === 'continuations' ? 2 : false;
    assert.throws(() => validateEditingContinuity(report));
  }
});

test('same living editing child separates action completion from naturally drained positive closure', async () => {
  const directory = temporary();
  const url = new URL('./live-production-proof-lanes.mjs', import.meta.url).href;
  const code = `import {openRecoveryHandoff} from ${JSON.stringify(url)};
    const h=await openRecoveryHandoff({directory:${JSON.stringify(directory)},identity:${JSON.stringify(identity)},onCancel(){throw new Error('unexpected-cancel')}});
    await h.boundary(); h.finishActions();
    await new Promise(done=>setTimeout(done,150)); await h.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    stdio: 'ignore',
  });
  const exited = new Promise((done) => child.once('close', done));
  const birth = processBirth(child.pid);
  writeFileSync(join(directory, 'launched.json'), JSON.stringify({ identity, birth }), {
    mode: 0o600,
  });
  try {
    await observeRecoveryPhase(directory, (state) => state.phase === 'ready', 3000, identity);
    const expected = JSON.parse(readFileSync(join(directory, 'driver.json')));
    await handoffRequest(directory, 'continue', expected);
    const state = await observeRecoveryPhase(
      directory,
      (row) => row.phase === 'settling',
      3000,
      identity,
    );
    assert.equal(state.phase, 'settling');
    assert.equal(birthCurrent(birth), true);
    await assert.rejects(handoffRequest(directory, 'continue', expected));
    const cleanup = await settleRecoveryDriver(directory, identity, 3000, true);
    assert.equal(cleanup.cancelAttempted, false);
    assert.equal(cleanup.cancelSent, false);
    assert.equal(cleanup.finalDriverVerified, true);
    assert.equal(cleanup.driverExited, true);
    assert.equal(await exited, 0);
  } finally {
    if (birthCurrent(birth)) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
test('editing aggregate refuses missing or substituted physical driver cleanup even with passing action phases', () => {
  for (const change of [
    (p) => {
      delete p.reports['editing-driver-cleanup.json'];
    },
    (p) => {
      const d = JSON.parse(p.reports['editing-driver-cleanup.json']);
      d.finalDriverVerified = false;
      p.reports['editing-driver-cleanup.json'] = Buffer.from(JSON.stringify(d));
    },
    (p) => {
      const d = JSON.parse(p.reports['editing-driver-cleanup.json']);
      d.birth.start = '2';
      p.reports['editing-driver-cleanup.json'] = Buffer.from(JSON.stringify(d));
    },
    (p) => {
      const d = JSON.parse(p.reports['editing-driver-cleanup.json']);
      d.driverExited = false;
      p.reports['editing-driver-cleanup.json'] = Buffer.from(JSON.stringify(d));
    },
  ]) {
    const all = packets();
    change(all['accept-steer']);
    if (all['accept-steer'].reports['editing-driver-cleanup.json'])
      all['accept-steer'].receipt.reports['editing-driver-cleanup.json'] = createHash('sha256')
        .update(all['accept-steer'].reports['editing-driver-cleanup.json'])
        .digest('hex');
    assert.throws(() => aggregateLanes(all, identity));
  }
});

test('expired editing cleanup persists unresolved operation and lock while the exact child is still alive', async () => {
  const directory = temporary();
  const url = new URL('./live-production-proof-lanes.mjs', import.meta.url).href;
  const code = `import {openRecoveryHandoff} from ${JSON.stringify(url)};
    const h=await openRecoveryHandoff({directory:${JSON.stringify(directory)},identity:${JSON.stringify(identity)},onCancel(){}});
    await h.boundary(); h.finishActions(); await new Promise(done=>setTimeout(done,5000)); await h.close();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
    stdio: 'ignore',
  });
  const exited = new Promise((done) => child.once('close', done));
  const birth = processBirth(child.pid);
  writeFileSync(join(directory, 'launched.json'), JSON.stringify({ identity, birth }), {
    mode: 0o600,
  });
  try {
    await observeRecoveryPhase(directory, (state) => state.phase === 'ready', 3000, identity);
    const expected = JSON.parse(readFileSync(join(directory, 'driver.json')));
    await handoffRequest(directory, 'continue', expected);
    await observeRecoveryPhase(directory, (state) => state.phase === 'settling', 3000, identity);
    await assert.rejects(settleRecoveryDriver(directory, identity, 50, true), /CLEANUP_UNVERIFIED/);
    const cleanup = JSON.parse(readFileSync(join(directory, 'cleanup.json')));
    assert.equal(cleanup.driverExited, false);
    assert.equal(cleanup.operationSettlementUnverified, true);
    assert.equal(cleanup.lockRetained, true);
    assert.equal(cleanup.finalDriverVerified, undefined);
    assert.equal(cleanup.cancelSent, false);
    assert.equal(birthCurrent(birth), true);
  } finally {
    if (birthCurrent(birth)) {
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Shift the logical origin, preserving real elapsed time for the actual handoff timers.
// A short host uptime must not make a historical phase start or job anchor negative.
function testWithEditingClock(name, run) {
  for (const uptimeSeconds of [0, 1, 60, 1309, 1310, 3600]) {
    test(`${name} (host uptime ${uptimeSeconds}s)`, async (t) => {
      const realNow = process.hrtime.bigint.bind(process.hrtime),
        realStart = realNow(),
        logicalStart = 1_310_000_000_000n + BigInt(uptimeSeconds) * 1_000_000_000n;
      t.mock.method(process.hrtime, 'bigint', () => logicalStart + realNow() - realStart);
      await run();
    });
  }
}
async function editingHandoff({
  left = 5000,
  onCancel = async () => {},
  onFailure = () => {},
} = {}) {
  const directory = temporary(),
    now = process.hrtime.bigint();
  const anchor = { boot: processBirth().boot, monotonicNs: (now - 1_310_000_000_000n).toString() };
  const phaseA = editingPhaseBound(anchor, 'accepted', now - BigInt(1_260_000 - left) * 1_000_000n);
  const editing = { anchor, phaseA },
    birth = processBirth();
  writeFileSync(join(directory, 'launched.json'), JSON.stringify({ identity, birth, editing }), {
    mode: 0o600,
  });
  const handoff = await openRecoveryHandoff({ directory, identity, editing, onCancel, onFailure });
  return { directory, handoff, expected: handoff.snapshot(), editing, birth };
}
function writeContinuation(h, phaseB = editingPhaseBound(h.editing.anchor, 'action')) {
  writeFileSync(
    join(h.directory, 'continuation.json'),
    JSON.stringify({ identity, birth: h.birth, phaseB }),
    { mode: 0o600, flag: 'wx' },
  );
  return phaseB;
}
test('parent phase bounds intersect one immutable global clock and reject reset, malformed, future or changed metadata', () => {
  const anchor = { monotonicNs: '0' },
    now = 79_000_000_000n;
  const bound = editingPhaseBound(anchor, 'accepted', now);
  assert.deepEqual(bound, {
    phase: 'accepted',
    startedNs: now.toString(),
    deadlineNs: '1339000000000',
  });
  assert.equal(phaseBoundRemaining(bound, 1_339_000_000_000n), 0);
  assert.equal(validateEditingPhaseBound(bound, anchor, 'accepted', now), bound);
  const nearGlobal = editingPhaseBound(anchor, 'accepted', 1_370_000_000_000n);
  assert.equal(nearGlobal.deadlineNs, '1380000000000');
  const b = editingPhaseBound(anchor, 'action', 1_379_000_000_000n);
  assert.equal(b.deadlineNs, '2399000000000');
  for (const change of [
    { deadlineNs: '1380000000000' },
    { phase: 'action' },
    { startedNs: '80000000000' },
    { extra: true },
    { deadlineNs: '-1' },
  ])
    assert.throws(() =>
      validateEditingPhaseBound({ ...bound, ...change }, anchor, 'accepted', now),
    );
  assert.throws(
    () => editingPhaseBound(anchor, 'accepted', 1_380_000_000_000n),
    /PROOF_DRIVER_PHASE_DEADLINE/,
  );
});
testWithEditingClock(
  'actual editing driver and parent share exact A cutoff; expiry keeps original raw operation owned until drained',
  async () => {
    let release,
      stops = 0,
      closed = false;
    const raw = new Promise((resolve) => {
        release = resolve;
      }),
      failures = [];
    const h = await editingHandoff({
      left: 150,
      onFailure: (code) => failures.push(code),
      onCancel: async () => {
        await raw;
        stops++;
      },
    });
    try {
      assert.equal(h.expected.schemaVersion, 2);
      assert.equal(h.handoff.deadlineNs('accepted'), h.editing.phaseA.deadlineNs);
      await assert.rejects(
        observeRecoveryPhase(
          h.directory,
          (s) => s.phase === 'ready',
          1000,
          identity,
          h.editing.phaseA,
        ),
        /PROOF_DRIVER_PHASE_DEADLINE/,
      );
      await waitFor(5);
      assert.equal(h.handoff.snapshot().cancelled, true);
      assert.throws(() => h.handoff.assertCurrent(), /PROOF_DRIVER_PHASE_DEADLINE/);
      assert.equal(stops, 0);
      const closing = h.handoff.close().then(() => {
        closed = true;
      });
      await waitFor(10);
      assert.equal(closed, false);
      release();
      await closing;
      assert.equal(stops, 1);
      assert.deepEqual(failures, ['PROOF_DRIVER_PHASE_DEADLINE']);
    } finally {
      release();
      await h.handoff.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  },
);
testWithEditingClock(
  'editing continuation carries exact original birth and B bound; missing, changed and replayed admission refuse',
  async () => {
    const h = await editingHandoff();
    const boundary = h.handoff.boundary();
    boundary.catch(() => {});
    try {
      await assert.rejects(
        handoffRequest(h.directory, 'continue', h.expected),
        /PROOF_HANDOFF_REFUSED/,
      );
      const phaseB = writeContinuation(h);
      await assert.rejects(
        handoffRequest(h.directory, 'continue', {
          ...h.expected,
          identity: { ...identity, tree: 'f'.repeat(40) },
        }),
        /PROOF_HANDOFF_REFUSED/,
      );
      assert.throws(
        () =>
          handoffRequest(h.directory, 'continue', {
            ...h.expected,
            birth: { ...h.birth, start: '0' },
          }),
        /PROOF_DRIVER_EXITED/,
      );
      const state = await handoffRequest(h.directory, 'continue', h.expected);
      await boundary;
      assert.deepEqual(state.phaseB, phaseB);
      assert.equal(h.handoff.deadlineNs('action'), phaseB.deadlineNs);
      await assert.rejects(
        handoffRequest(h.directory, 'continue', h.expected),
        /PROOF_HANDOFF_REFUSED/,
      );
      const changed = editingPhaseBound(h.editing.anchor, 'action');
      writeFileSync(
        join(h.directory, 'continuation.json'),
        JSON.stringify({ identity, birth: h.birth, phaseB: changed }),
        { mode: 0o600 },
      );
      await assert.rejects(
        handoffRequest(h.directory, 'status', h.expected),
        /PROOF_HANDOFF_REFUSED/,
      );
      writeFileSync(
        join(h.directory, 'continuation.json'),
        JSON.stringify({ identity, birth: h.birth, phaseB }),
        { mode: 0o600 },
      );
      h.handoff.finishActions();
    } finally {
      await h.handoff.cancel();
      await boundary.catch(() => {});
      await h.handoff.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  },
);
testWithEditingClock(
  'parent refuses changed protected A cutoff and no expired B may release continuation',
  async () => {
    const h = await editingHandoff();
    const boundary = h.handoff.boundary();
    boundary.catch(() => {});
    try {
      const wrong = {
        ...h.editing.phaseA,
        deadlineNs: (BigInt(h.editing.phaseA.deadlineNs) + 1n).toString(),
      };
      await assert.rejects(
        observeRecoveryPhase(h.directory, () => true, 100, identity, wrong),
        /PROOF_DRIVER_METADATA_CHANGED/,
      );
      const now = process.hrtime.bigint();
      const expired = editingPhaseBound(h.editing.anchor, 'action', now - 1_020_001_000_000n);
      writeContinuation(h, expired);
      await assert.rejects(
        handoffRequest(h.directory, 'continue', h.expected),
        /PROOF_HANDOFF_REFUSED/,
      );
      assert.equal(h.handoff.snapshot().continuations, 0);
    } finally {
      await h.handoff.cancel();
      await boundary.catch(() => {});
      await h.handoff.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  },
);
test('fixed first-cause taxonomy recognizes actual assertion message and never copies arbitrary errors', () => {
  assert.equal(
    fixedProofFailure({ code: 'ERR_ASSERTION', message: 'PROOF_CANCELLED' }),
    'PROOF_CANCELLED',
  );
  assert.equal(
    fixedProofFailure(new Error('PROOF_DRIVER_PHASE_DEADLINE')),
    'PROOF_DRIVER_PHASE_DEADLINE',
  );
  for (const message of [
    'private-bearer-canary',
    'PROOF_CANCELLED\nprivate-canary',
    'https://private.test/token',
  ])
    assert.equal(fixedProofFailure(new Error(message)), null);
});

testWithEditingClock(
  'actual API admits once, retains the original RPC through cancellation and refuses its late result and any next dispatch',
  async () => {
    let release,
      calls = 0,
      jsonReads = 0,
      stops = 0;
    const raw = new Promise((resolve) => {
        release = resolve;
      }),
      editingApiRaw = new Set();
    const h = await editingHandoff({
      left: 120,
      onCancel: async () => {
        await Promise.allSettled([...editingApiRaw]);
        stops++;
      },
    });
    const source = readFileSync(
      new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
      'utf8',
    );
    const begin = source.indexOf('async function api(method, path, payload) {'),
      end = source.indexOf('\ntry {', begin);
    const api = new Function(
      'recoveryHandoff',
      'mobile',
      'headers',
      'report',
      'editingContinuity',
      'editingApiRaw',
      source.slice(begin, end) + '; return api;',
    )(
      h.handoff,
      {
        inject() {
          calls++;
          return raw;
        },
      },
      {},
      {},
      true,
      editingApiRaw,
    );
    try {
      const admitted = api('POST', '/actual-owner', {});
      const refused = assert.rejects(admitted, /PROOF_DRIVER_PHASE_DEADLINE/);
      assert.equal(editingApiRaw.size, 1);
      await waitFor(150);
      assert.equal(stops, 0);
      assert.equal(editingApiRaw.size, 1);
      await assert.rejects(api('POST', '/later-edit', {}), /PROOF_DRIVER_PHASE_DEADLINE/);
      assert.equal(calls, 1);
      release({
        statusCode: 200,
        json() {
          jsonReads++;
          return {};
        },
      });
      await refused;
      await h.handoff.close();
      assert.equal(editingApiRaw.size, 0);
      assert.equal(stops, 1);
      assert.equal(jsonReads, 0);
    } finally {
      release({ statusCode: 200, json: () => ({}) });
      await h.handoff.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  },
);

testWithEditingClock(
  'actual continued child and parent expire at the exact original B cutoff, retaining pending cancellation until raw settlement',
  async () => {
    let release,
      stopped = false;
    const raw = new Promise((resolve) => {
      release = resolve;
    });
    const h = await editingHandoff({
      onCancel: async () => {
        await raw;
        stopped = true;
      },
    });
    const boundary = h.handoff.boundary();
    boundary.catch(() => {});
    try {
      const phaseB = editingPhaseBound(
        h.editing.anchor,
        'action',
        process.hrtime.bigint() - 1_019_850_000_000n,
      );
      writeContinuation(h, phaseB);
      await handoffRequest(h.directory, 'continue', h.expected);
      await boundary;
      await assert.rejects(
        observeRecoveryPhase(h.directory, (s) => s.phase === 'settling', 1000, identity, phaseB),
        /PROOF_DRIVER_PHASE_DEADLINE/,
      );
      await waitFor(5);
      assert.throws(() => h.handoff.assertCurrent(), /PROOF_DRIVER_PHASE_DEADLINE/);
      assert.equal(stopped, false);
      assert.equal(h.handoff.snapshot().continuations, 1);
      release();
      await h.handoff.close();
      assert.equal(stopped, true);
    } finally {
      release();
      await h.handoff.cancel();
      await boundary.catch(() => {});
      await h.handoff.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  },
);

test('explicit serial profile marker selects one full accept continuity lane with partial evidence and rejects every conflicting route', () => {
  const selected = { eventName: 'push', message: '[full-native] [serial-accept-profile]' };
  assert.deepEqual(selectedLanes(selected), {
    mode: 'full',
    lanes: ['accept-steer'],
    verificationScope: 'editing-only',
  });
  for (const mutation of [
    { eventName: 'pull_request' },
    { eventName: 'workflow_dispatch' },
    { message: '[serial-accept-profile]' },
    { preflight: true },
    { pickerSmoke: true },
    { pickerDiagnostic: true },
    { independentOnly: true },
    ...[
      '[editing-lanes]',
      '[picker-smoke]',
      '[picker-diagnostic]',
      '[independent-only]',
      '[seeded-admission]',
    ].map((marker) => ({ message: selected.message + ' ' + marker })),
  ])
    assert.throws(() => selectedLanes({ ...selected, ...mutation }));
  assert.deepEqual(selectedLanes({ eventName: 'push', message: '[full-native]' }).lanes, fullLanes);
  assert.deepEqual(
    selectedLanes({ eventName: 'push', message: '[full-native] [editing-lanes]' }).lanes,
    ['accept-steer', 'manual-discard'],
  );
  const workflow = readFileSync(
    new URL('../.github/workflows/live-caddy-proof.yml', import.meta.url),
    'utf8',
  );
  const phaseA = workflow.slice(
    workflow.indexOf("      - name: 'Accept editing phase A:"),
    workflow.indexOf("      - name: 'Accept editing phase B:"),
  );
  const receipt = workflow.slice(
    workflow.indexOf('      - name: Validate complete exact-candidate lane evidence'),
    workflow.indexOf('      - name: Check fixed editing artifact allocation'),
  );
  assert.ok(
    phaseA.includes(
      "LIVE_PRODUCTION_SERIAL_PROFILE: ${{ contains(github.event.head_commit.message, '[serial-accept-profile]') && '1' || '0' }}",
    ),
  );
  assert.ok(
    phaseA.includes(
      "LIVE_PRODUCTION_PROFILE_TRIAL: ${{ contains(github.event.head_commit.message, '[serial-accept-profile]') && 'serial-accept-baseline-1' || '' }}",
    ),
  );
  assert.ok(receipt.includes('LIVE_PRODUCTION_SERIAL_PROFILE:'));
  assert.ok(workflow.includes("verification-scope != 'editing-only'"));
  assert.ok(phaseA.includes('timeout-minutes: 21'));
});
// Synthetic schema fixture only; this does not supply authentic profiling evidence.
function profileContract() {
  let now = 1n;
  const profile = createSerialProfile(
    {
      trialId: 'serial-accept-baseline-1',
      identity,
      birth: { pid: 1, start: '1', boot: 'a'.repeat(36) },
      anchor: { boot: 'a'.repeat(36), monotonicNs: '0' },
      phaseA: { phase: 'accepted', startedNs: '0', deadlineNs: '1260000000000' },
    },
    () => now,
  );
  const begin = (label, at, metadata = {}) => {
    now = BigInt(at);
    return profile.begin(label, metadata);
  };
  const end = (id, at) => {
    now = BigInt(at);
    profile.end(id, 'completed');
  };
  const first = begin('idempotent-start', 1, { generation: 1 });
  const poll = begin('poll-authority', 2, { generation: 1 });
  profile.report.spans.at(-1).grantedNs = '3';
  end(poll, 4);
  end(first, 5);
  const generate = begin('generate-authority', 6, { generation: 1, eventDigest: 'f'.repeat(64) });
  profile.report.spans.at(-1).grantedNs = '7';
  const root = begin('root-confinement', 8, { parentId: generate });
  const child = begin('child-confinement', 9, { parentId: root });
  end(child, 10);
  end(root, 11);
  end(begin('first-source-patch', 12, { parentId: root }), 13);
  end(generate, 14);
  for (const [index, label] of [
    'accept-ack',
    'post-accept-poll',
    'browser-close',
    'disconnect-ack',
    'disconnect-revoke',
  ].entries())
    end(begin(label, 15 + index * 2), 16 + index * 2);
  profile.report.originalOwner = {
    generation: 1,
    liveDigest: 'c'.repeat(64),
    rootThreadDigest: 'd'.repeat(64),
    captureDigest: 'e'.repeat(64),
    nativeBirthDigest: 'f'.repeat(64),
  };
  return profile;
}
test('profile validity rejects swallowed diagnostic failures, pending raw rows, missing observations, stale identity and unbounded data', () => {
  assert.equal(validateSerialProfile(profileContract().report), true);
  for (const mutate of [
    (p) => {
      p.firstFailure = { code: 'PROOF_PROFILE_INVALID', observedNs: null };
    },
    (p) => {
      p.spans[0].outcome = 'pending';
      p.spans[0].endNs = null;
    },
    (p) => {
      p.spans.pop();
    },
    (p) => {
      p.spans[0].endNs = '1260000000001';
    },
    (p) => {
      p.spans[2].grantedNs = undefined;
    },
    (p) => {
      p.spans[4].parentId = 'profile-9999';
    },
    (p) => {
      p.originalOwner.generation = 3;
    },
    (p) => {
      p.spans[0].privatePayload = 'canary';
    },
    (p) => {
      p.spans[0].label = 'arbitrary';
    },
  ]) {
    const report = profileContract().report;
    mutate(report);
    assert.throws(() => validateSerialProfile(report), /PROOF_PROFILE_INVALID/);
  }
});
test('profile128-span cap refuses before new dispatch and invalidates trial; ordinary lane receipt stays unchanged', () => {
  const profile = profileContract();
  let dispatched = 0;
  while (profile.report.spans.length < 128) profile.trace('event-authority', () => 'settled');
  assert.throws(
    () =>
      profile.trace('poll-authority', () => {
        dispatched++;
      }),
    /PROOF_PROFILE_INVALID/,
  );
  assert.equal(dispatched, 0);
  assert.equal(profile.report.spans.length, 128);
  assert.throws(() => validateSerialProfile(profile.report), /PROOF_PROFILE_INVALID/);
});
test('explicit profile receipt requires valid complete profiling and remains partial; missing or silently invalid profile cannot publish success', () => {
  const directory = temporary(),
    file = 'production-entrypoint/production-entrypoint-proof.json';
  mkdirSync(join(directory, 'production-entrypoint'));
  const report = production('accept-steer');
  writeFileSync(
    join(directory, 'editing-driver-cleanup.json'),
    packets()['accept-steer'].reports['editing-driver-cleanup.json'],
  );
  const save = () => writeFileSync(join(directory, file), JSON.stringify(report));
  try {
    save();
    assert.ok(writeLaneReceipt('accept-steer', directory, identity, 'full', 'editing-only'));
    assert.throws(() =>
      writeLaneReceipt('accept-steer', directory, identity, 'full', 'editing-only', true),
    );
    report.serialProfileTrialRequested = true;
    report.serialProfileValid = true;
    report.serialProfile = profileContract().report;
    save();
    const receipt = writeLaneReceipt(
      'accept-steer',
      directory,
      identity,
      'full',
      'editing-only',
      true,
    );
    assert.equal(receipt.profilingTrial, 'serial-accept-baseline-1');
    assert.equal(receipt.fullExactCandidateStillRequired, true);
    const all = packets();
    all['accept-steer'] = loadLanePacket(directory);
    assert.throws(() => aggregateLanes(all, identity));
    for (const mutate of [
      (p) => {
        p.serialProfileValid = false;
      },
      (p) => {
        p.serialProfile.firstFailure = { code: 'PROOF_PROFILE_INVALID' };
      },
      (p) => {
        p.serialProfile.binding.identity.tree = '0'.repeat(40);
      },
      (p) => {
        p.serialProfile.binding.birth.start = '2';
      },
    ]) {
      report.serialProfile = profileContract().report;
      report.serialProfileValid = true;
      mutate(report);
      save();
      assert.throws(() =>
        writeLaneReceipt('accept-steer', directory, identity, 'full', 'editing-only', true),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual final profile gate rejects silent observer invalidity while ordinary completion stays unchanged', () => {
  const source = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  const start = source.lastIndexOf('  if (serialProfileRequested) {'),
    end = source.indexOf("  report.cleanupStage = 'settled';", start);
  assert.ok(start > 0 && end > start);
  const gate = new Function(
    'serialProfileRequested',
    'report',
    'validateSerialProfile',
    'process',
    source.slice(start, end),
  );
  const ordinary = { passed: true, cleanupComplete: true },
    ordinaryProcess = {};
  gate(false, ordinary, validateSerialProfile, ordinaryProcess);
  assert.deepEqual(ordinary, { passed: true, cleanupComplete: true });
  assert.equal(ordinaryProcess.exitCode, undefined);
  const good = { passed: true, cleanupComplete: true, serialProfile: profileContract().report };
  gate(true, good, validateSerialProfile, {});
  assert.equal(good.passed, true);
  assert.equal(good.serialProfileValid, true);
  const bad = { passed: true, cleanupComplete: true, serialProfile: profileContract().report },
    processState = {};
  bad.serialProfile.firstFailure = { code: 'PROOF_PROFILE_INVALID', observedNs: null };
  gate(true, bad, validateSerialProfile, processState);
  assert.equal(bad.passed, false);
  assert.equal(bad.serialProfileValid, false);
  assert.equal(processState.exitCode, 1);
  assert.equal(bad.cleanupComplete, true);
  assert.equal(bad.firstFixedFailure.code, 'PROOF_PROFILE_INVALID');
});
test('a caught end-observation failure preserves raw result but invalidates profile instead of claiming success', async () => {
  let now = 100n,
    release;
  const profile = createSerialProfile(profileContract().report.binding, () => now);
  const raw = new Promise((resolve) => {
    release = resolve;
  });
  assert.equal(
    profile.trace('idempotent-start', () => raw),
    raw,
  );
  now = 0n;
  release('original-success');
  assert.equal(await raw, 'original-success');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(profile.report.firstFailure.code, 'PROOF_PROFILE_INVALID');
  assert.equal(profile.report.spans[0].endNs, null);
  assert.throws(() => validateSerialProfile(profile.report), /PROOF_PROFILE_INVALID/);
});

test('generated authority callback refusal records fixed invalidity even if its caller catches the diagnostic error', () => {
  const profile = createSerialProfile(profileContract().report.binding);
  assert.throws(() => profile.granted(), /PROOF_PROFILE_INVALID/);
  assert.equal(profile.report.firstFailure.code, 'PROOF_PROFILE_INVALID');
  assert.throws(() => validateSerialProfile(profile.report), /PROOF_PROFILE_INVALID/);
});
