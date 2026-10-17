/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
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
  birthCurrent,
  fullLanes,
  fullAssertionOwners,
  laneChecks,
  independentChecks,
  openRecoveryHandoff,
  handoffRequest,
  processBirth,
  productionLane,
  proofPins,
  selectedLanes,
  loadLanePacket,
} from './live-production-proof-lanes.mjs';

const identity = { candidate: 'a'.repeat(40), tree: 'b'.repeat(40), runId: '123', ...proofPins };
function production(lane) {
  return {
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
