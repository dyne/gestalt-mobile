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
  if (lane === 'manual-discard') {
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
              ...(lane === 'recovery'
                ? {
                    'recovery-driver-cleanup.json': {
                      identity,
                      driverExited: true,
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
        r.editBrowser.acceptContinuity.visibleChrome = false;
      },
    ],
    [
      'accept-steer',
      (r) => {
        r.editBrowser.acceptContinuity.freshDocumentHelperConnected = false;
      },
    ],
    [
      'accept-steer',
      (r) => {
        r.editBrowser.acceptContinuity.acceptedHeading = false;
      },
    ],
    [
      'accept-steer',
      (r) => {
        r.editBrowser.acceptContinuity.elapsedMs = 300000;
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
