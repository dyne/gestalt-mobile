/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  selectedLanes,
  fullLanes,
  mintCatalogObservation,
  readCatalogObservation,
  processBirth,
  proofPins,
} from './live-production-proof-lanes.mjs';
import {
  catalogProviderProbe,
  catalogDriverBudget,
  catalogReceiptObserver,
  correlateCatalogReceipts,
  coldCatalogLifecycle,
  drainCatalogCancellation,
  validateColdCatalog,
} from './live-production-cold-catalog.mjs';

function instantReceiptObserver(options = {}) {
  const now = options.now ?? (() => performance.now());
  const actual = catalogReceiptObserver(options);
  return {
    ...actual,
    sample(receipts, scan = { startedAt: now(), endedAt: now() }) {
      actual.sample(receipts, scan);
    },
  };
}

const launchId = '12345678-1234-4234-8234-123456789abc';
function receipt(stage, generation = 4) {
  const row = {
    receipt: { launchId, commandId: 'context-mode-call' },
    manifestDigest: 'a'.repeat(64),
    generation,
    captureId: 'private-capture-canary',
  };
  if (stage === 'authorized') row.receipt.kind = 'authorized-launch';
  else
    Object.assign(row.receipt, {
      kind: 'process-launch',
      status: stage === 'exited' ? 'exited' : 'running',
      postSpawnValidated: stage === 'validated',
      process: { pid: 123, birth: '456', private: 'private-process-canary' },
      policy: { manifestDigest: row.manifestDigest },
    });
  return row;
}

test('cold diagnostic is explicit exclusive partial scope and leaves full/editing/profile selection intact', () => {
  assert.deepEqual(
    selectedLanes({ eventName: 'push', message: '[full-native] [cold-catalog-diagnostic]' }),
    {
      mode: 'cold-catalog-diagnostic',
      lanes: ['cold-catalog'],
      verificationScope: 'diagnostic-only',
    },
  );
  for (const marker of [
    '[editing-lanes]',
    '[serial-accept-profile]',
    '[seeded-admission]',
    '[picker-smoke]',
    '[picker-diagnostic]',
    '[independent-only]',
  ])
    assert.throws(() =>
      selectedLanes({
        eventName: 'push',
        message: `[full-native] [cold-catalog-diagnostic] ${marker}`,
      }),
    );
  for (const eventName of ['workflow_dispatch', 'pull_request'])
    assert.throws(() =>
      selectedLanes({ eventName, message: '[full-native] [cold-catalog-diagnostic]' }),
    );
  for (const key of ['preflight', 'pickerSmoke', 'pickerDiagnostic', 'independentOnly'])
    assert.throws(() =>
      selectedLanes({
        eventName: 'push',
        message: '[full-native] [cold-catalog-diagnostic]',
        [key]: true,
      }),
    );
  assert.throws(() => selectedLanes({ eventName: 'push', message: '[cold-catalog-diagnostic]' }));
  assert.deepEqual(selectedLanes({ eventName: 'push', message: '[full-native]' }).lanes, [
    ...fullLanes,
  ]);
  assert.deepEqual(
    selectedLanes({ eventName: 'push', message: '[full-native] [editing-lanes]' }).lanes,
    ['accept-steer', 'manual-discard'],
  );
  assert.deepEqual(
    selectedLanes({ eventName: 'push', message: '[full-native] [serial-accept-profile]' }).lanes,
    ['accept-steer'],
  );
});

test('only exact body-free preparation probes allowed; model and canary bodies never decoded', () => {
  assert.deepEqual(catalogProviderProbe('HEAD', '/v1/responses', {}), {
    method: 'HEAD',
    path: '/v1/responses',
    status: 405,
  });
  assert.deepEqual(catalogProviderProbe('GET', '/v1/models', { 'content-length': '0' }), {
    method: 'GET',
    path: '/v1/models',
    status: 200,
  });
  for (const [method, path, headers] of [
    ['POST', '/v1/responses', {}],
    ['GET', '/v1/models?secret=canary', {}],
    ['HEAD', '/v1/responses/', {}],
    ['GET', 'https://provider.invalid/v1/models', {}],
    ['GET', '/v1/models', { 'content-length': '1' }],
    ['HEAD', '/v1/responses', { 'transfer-encoding': 'chunked' }],
  ])
    assert.throws(
      () => catalogProviderProbe(method, path, headers),
      (error) =>
        error.message === 'COLD_CATALOG_EVIDENCE_INVALID' && !error.message.includes('canary'),
    );
});

test('signed-receipt adapter output retains new command intervals, missing stages, stable owner binding and no payloads', () => {
  let time = 100;
  const observed = instantReceiptObserver({ now: () => time, origin: 0 });
  observed.sample([]);
  for (const stage of ['authorized', 'running', 'validated', 'exited']) {
    time += 10;
    observed.sample([receipt(stage)]);
  }
  observed.assertValid();
  assert.deepEqual(observed.report.launches[0].stages, [
    { stage: 'authorized', afterMs: 100, byMs: 110, scanStartedMs: 110 },
    { stage: 'running', afterMs: 110, byMs: 120, scanStartedMs: 120 },
    { stage: 'post-spawn-validated', afterMs: 120, byMs: 130, scanStartedMs: 130 },
    { stage: 'exited', afterMs: 130, byMs: 140, scanStartedMs: 140 },
  ]);
  const text = JSON.stringify(observed.report);
  assert.ok(!text.includes('canary') && !text.includes(launchId));
  assert.equal(observed.report.workerImportUnobserved, true);
  const missed = instantReceiptObserver();
  missed.sample([receipt('exited')]);
  missed.assertValid();
  assert.deepEqual(
    missed.report.launches[0].stages.map((row) => row.stage),
    ['exited'],
  );
});

for (const mutation of ['generation', 'capture', 'manifest', 'birth', 'backwards', 'overflow'])
  test(`receipt correlation refuses ${mutation} without inventing a stage`, () => {
    const observer = instantReceiptObserver();
    observer.sample([receipt('running')]);
    if (mutation === 'overflow') {
      for (let i = 1; i <= 32; i++) {
        const value = receipt('running');
        value.receipt.launchId = `${String(i).padStart(8, '0')}-1234-4234-8234-123456789abc`;
        observer.sample([value]);
      }
    } else {
      const value = receipt(mutation === 'backwards' ? 'authorized' : 'validated');
      if (mutation === 'generation') value.generation++;
      if (mutation === 'capture') value.captureId = 'wrong';
      if (mutation === 'manifest') value.receipt.policy.manifestDigest = 'b'.repeat(64);
      if (mutation === 'birth') value.receipt.process.birth = '457';
      observer.sample([value]);
    }
    assert.throws(() => observer.assertValid(), /COLD_CATALOG_EVIDENCE_INVALID/);
    assert.equal(observer.report.valid, false);
  });

function lifecycleFixture(mutation) {
  const calls = [],
    report = {},
    original = { liveId: 'same-live', generation: 1 };
  let closed = false,
    cancelled = false;
  const input = {
    report,
    original,
    prefix: '/actual/session/live',
    api: async (method, path) => {
      calls.push([method, path]);
      if (method === 'GET')
        return {
          state: 'recoveryRequired',
          liveId: mutation === 'disconnect-live' ? 'wrong' : original.liveId,
          generation: 2,
        };
      if (mutation === 'cancel-pending') cancelled = true;
      return {
        state: 'active',
        liveId: mutation === 'resume-live' ? 'wrong' : original.liveId,
        generation: mutation === 'stale' ? 2 : 3,
      };
    },
    until: async (check) => assert.equal(await check(), true),
    capture: (run) => ({
      birth: mutation === 'birth' && run.generation === 3 ? 'changed' : 'original',
      accountDigest: mutation === 'account' && run.generation === 3 ? 'changed' : 'account',
      selection: mutation === 'selection' && run.generation === 3 ? 'changed' : 'model-selection',
      captureId: mutation === 'capture' ? 'same' : `capture-${run.generation}`,
    }),
    source: () => (mutation === 'source' && calls.length > 1 ? 'changed' : 'original-source'),
    providerCount: () => (mutation === 'inference' ? 1 : 0),
    closeStream: () => {
      closed = true;
    },
    signedRevoked: () => true,
    assertCurrent: () => {
      if (cancelled || mutation === 'cancel-before') throw Error('PROOF_CANCELLED');
    },
  };
  return { input, calls, report, closed: () => closed };
}

test('one unseeded lifecycle joins original Resume before capture/source/selection success and never edits', async () => {
  const fixture = lifecycleFixture();
  const run = await coldCatalogLifecycle(fixture.input);
  assert.equal(run.generation, 3);
  assert.equal(fixture.closed(), true);
  assert.deepEqual(fixture.calls, [
    ['GET', '/actual/session/live'],
    ['POST', '/actual/session/live/resume'],
  ]);
  assert.equal(fixture.report.resumeInvocations, 1);
  assert.equal(fixture.report.sameOriginalBirth, true);
});
for (const mutation of [
  'disconnect-live',
  'resume-live',
  'stale',
  'birth',
  'account',
  'selection',
  'capture',
  'source',
  'inference',
  'cancel-before',
  'cancel-pending',
])
  test(`lifecycle rejects ${mutation} and cannot authorize Generate/Accept/late edit`, async () => {
    const fixture = lifecycleFixture(mutation);
    await assert.rejects(coldCatalogLifecycle(fixture.input));
    assert.ok(fixture.calls.filter(([method]) => method === 'POST').length <= 1);
    assert.equal(fixture.report.sameOriginalBirth, undefined);
    assert.ok(fixture.calls.every(([, path]) => !/generate|turn|steer|accept|start/.test(path)));
  });

test('cancellation starts actual close before original raw settlement and retains both on refusal', async () => {
  for (const refusal of [false, true]) {
    let release,
      joined = false,
      closeStarted = false;
    const raw = new Promise((done) => {
      release = done;
    });
    const drain = drainCatalogCancellation([raw], async () => {
      closeStarted = true;
      if (refusal) throw Error('secret-canary');
    }).then(
      () => {
        joined = true;
      },
      (error) => {
        joined = true;
        assert.equal(error.message, 'COLD_CATALOG_CLEANUP_UNVERIFIED');
      },
    );
    try {
      await new Promise((done) => setImmediate(done));
      assert.equal(closeStarted, true);
      assert.equal(joined, false);
    } finally {
      release();
      await drain;
    }
    assert.equal(joined, true);
  }
});

test('owned test child cannot exit while original cancelled raw obligation remains held', async () => {
  const source = `import {drainCatalogCancellation} from ${JSON.stringify(new URL('./live-production-cold-catalog.mjs', import.meta.url).href)};
    let release;const raw=new Promise(done=>release=done);
    process.on('message',message=>{if(message==='release')release();});
    await drainCatalogCancellation([raw],async()=>process.send('close-started'));
    process.send('settled');process.disconnect();`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'close');
  try {
    assert.deepEqual(await once(child, 'message'), ['close-started', undefined]);
    assert.equal(child.exitCode, null);
  } finally {
    const settled = once(child, 'message');
    child.send('release');
    assert.deepEqual(await settled, ['settled', undefined]);
    assert.equal((await exited)[0], 0);
  }
});

test('trusted workflow diagnostic excludes seeded/model/recovery alternatives and requires distinct receipt', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/live-caddy-proof.yml', import.meta.url),
    'utf8',
  );
  const entrypoint = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(workflow.includes("matrix.lane != 'cold-catalog'"));
  for (const command of ['catalog-start', 'catalog-continue', 'catalog-cleanup', 'catalog-receipt'])
    assert.ok(workflow.includes(command));
  assert.ok(workflow.includes("LIVE_PRODUCTION_ADMISSION_SEED: '0'"));
  assert.ok(entrypoint.includes('if (coldCatalog || (preflightOnly && !seededPreflight))'));
  assert.ok(
    entrypoint.indexOf('catalogProviderProbe(req.method') <
      entrypoint.indexOf('for await (const chunk of req)'),
  );
  assert.ok(entrypoint.includes('const receipt = signed(path)'));
  assert.ok(entrypoint.includes('coldCatalogLifecycle({'));
  assert.throws(() =>
    validateColdCatalog(
      { passed: true, cleanupComplete: true, provenance: { head: 'a', tree: 'b' } },
      { candidate: 'a', tree: 'b' },
    ),
  );
});

test('new receipt timing correlates a unique original RPC group without adding overlapping durations', () => {
  let time = 100;
  const observer = instantReceiptObserver({ now: () => time, origin: 0 });
  observer.sample([]);
  for (const stage of ['authorized', 'running', 'validated', 'exited']) {
    time += 10;
    observer.sample([receipt(stage)]);
  }
  const catalog = { admissionOriginBoundsMs: [0, 1], receipts: observer.report };
  const admission = {
    calls: [
      { operation: 'admission-catalog-context', groupId: 7, startedAfterMs: 100, elapsedMs: 100 },
      { operation: 'admission-catalog-context', groupId: 8, startedAfterMs: 300, elapsedMs: 100 },
    ],
  };
  correlateCatalogReceipts(catalog, admission);
  assert.deepEqual(observer.report.launches[0].rpcGroupCandidates, [7]);
  assert.deepEqual(observer.report.launches[0].commandLifetimeBoundsMs, [10, 30]);
  admission.calls.push({ ...admission.calls[0], groupId: 9 });
  correlateCatalogReceipts(catalog, admission);
  assert.deepEqual(observer.report.launches[0].rpcGroupCandidates, [7, 9]);
  assert.equal(observer.report.workerImportUnobserved, true);
});

test('diagnostic receipt requires exact pins, original source checks, measured correlation and all cleanup; never integration acceptance', () => {
  const identity = {
    candidate: 'candidate',
    tree: 'tree',
    manager: 'manager',
    managerTree: 'managerTree',
    agents: 'agents',
    native: 'native',
  };
  const report = {
    provenance: { head: 'candidate', tree: 'tree', ...identity },
    nativeBinarySha256: 'native',
    proofKind: 'cold-catalog-diagnostic',
    passed: true,
    cleanupComplete: true,
    cleanupStage: 'settled',
    disposableTreeRemoved: true,
    provider: { requestCount: 0 },
    preflightSeedSkipped: true,
    preflight: Object.fromEntries(
      [
        'sameOwningNativeBirth',
        'originalCatalog11',
        'terminalPresealZeroTools',
        'actualPostsealCatalog7And12',
        'currentSignedPostSpawnProbe',
        'actualProductionStartActive',
      ].map((key) => [key, true]),
    ),
    sourceInventory: { signatureVerified: true, captureGenerationMatchesLiveGeneration: true },
    checks: Object.fromEntries(
      [
        'exactInstalledPreparedBytes',
        'originalManagedOwnerRetainedWithSignedV2Sources',
        'productionContextNativeAdmissionProbe',
        'sameSessionReuseNoReplacement',
      ].map((key) => [key, true]),
    ),
    coldCatalog: {
      inferenceRefusals: 0,
      trialId: 'cold-catalog-baseline-1',
      attempt: 1,
      actionFinishedNs: '100',
      bound: { deadlineNs: '200' },
      originalGeneration: 1,
      resumedGeneration: 3,
      fullAcceptance: false,
      resumeInvocations: 1,
      sameOriginalBirth: true,
      sourceUnchanged: true,
      sameSelection: true,
      restorationVerified: true,
      preparationProbes: [{ method: 'HEAD', path: '/v1/responses', status: 405, count: 1 }],
      receipts: {
        valid: true,
        launches: [
          {
            rpcGroupCandidates: [7],
            generation: 3,
            commandLifetimeBoundsMs: [10, 30],
            stages: [{ stage: 'post-spawn-validated' }, { stage: 'exited' }],
          },
        ],
      },
    },
  };
  assert.equal(validateColdCatalog(report, identity).fullAcceptance, false);
  for (const change of [
    (r) => (r.provenance.manager = 'wrong'),
    (r) => r.provider.requestCount++,
    (r) => r.coldCatalog.inferenceRefusals++,
    (r) => (r.coldCatalog.restorationVerified = false),
    (r) => (r.coldCatalog.fullAcceptance = true),
    (r) => r.coldCatalog.resumeInvocations++,
    (r) => (r.preflightSeedSkipped = false),
    (r) => (r.coldCatalog.receipts.launches[0].rpcGroupCandidates = [7, 8]),
    (r) => (r.coldCatalog.preparationProbes[0].path = '/secret-canary'),
    (r) => (r.shutdownFailure = 'UNVERIFIED'),
    (r) => (r.coldCatalog.receipts.launches[0].commandLifetimeBoundsMs = undefined),
    (r) => (r.coldCatalog.receipts.launches[0].generation = 1),
    (r) => (r.coldCatalog.actionFinishedNs = '201'),
  ]) {
    const broken = structuredClone(report);
    change(broken);
    assert.throws(() => validateColdCatalog(broken, identity));
  }
});

test('catalog setup/lifecycle/cleanup intersect one immutable job clock with no renewal of 720/180 caps', () => {
  const origin = 5_000_000_000n,
    anchor = { boot: 'clock-fixture', monotonicNs: origin.toString() };
  assert.equal(catalogDriverBudget(anchor, 'setup', origin), 1_680_000);
  assert.equal(catalogDriverBudget(anchor, 'observe', origin), 720_000);
  assert.equal(catalogDriverBudget(anchor, 'cleanup', origin), 180_000);
  const late = origin + 1_680_000_000_000n;
  assert.equal(catalogDriverBudget(anchor, 'observe', late), 720_000);
  assert.throws(() => catalogDriverBudget(anchor, 'setup', late), /PROOF_DRIVER_PHASE_DEADLINE/);
  assert.throws(
    () => catalogDriverBudget(anchor, 'observe', late + 1_000_000n),
    /PROOF_DRIVER_PHASE_DEADLINE/,
  );
  assert.equal(catalogDriverBudget(anchor, 'cleanup', origin + 2_579_999_000_000n), 1);
  assert.throws(
    () => catalogDriverBudget(anchor, 'cleanup', origin + 2_580_000_000_000n),
    /PROOF_DRIVER_PHASE_DEADLINE/,
  );
});

test('parent and original child share one candidate/birth-bound immutable observation cutoff; replay/change/stale identity refused', () => {
  const directory = mkdtempSync(join(tmpdir(), 'l11-catalog-clock-'));
  const birth = processBirth(),
    now = process.hrtime.bigint(),
    anchor = { boot: birth.boot, monotonicNs: now.toString() };
  const identity = { candidate: 'a'.repeat(40), tree: 'b'.repeat(40), runId: '123', ...proofPins };
  try {
    const original = mintCatalogObservation(directory, identity, birth, anchor, now);
    assert.equal(BigInt(original.deadlineNs) - BigInt(original.startedNs), 720_000_000_000n);
    assert.deepEqual(
      readCatalogObservation(directory, identity, birth, original, now + 1n),
      original,
    );
    assert.throws(() => mintCatalogObservation(directory, identity, birth, anchor, now), /EEXIST/);
    assert.throws(() =>
      readCatalogObservation(
        directory,
        { ...identity, tree: 'c'.repeat(40) },
        birth,
        original,
        now + 1n,
      ),
    );
    assert.throws(() =>
      readCatalogObservation(directory, identity, { ...birth, start: '0' }, original, now + 1n),
    );
    for (const key of ['deadlineNs', 'startedNs']) {
      const changed = { ...original, [key]: (BigInt(original[key]) + 1n).toString() };
      writeFileSync(join(directory, 'catalog-observation.json'), JSON.stringify(changed), {
        mode: 0o600,
      });
      assert.throws(() => readCatalogObservation(directory, identity, birth, original, now + 100n));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed first signed command observation stays invalid without throwing during final cleanup report correlation', () => {
  const observer = instantReceiptObserver({ origin: 0 });
  const malformed = receipt('running');
  malformed.receipt.policy.manifestDigest = 'changed';
  observer.sample([malformed]);
  assert.equal(observer.report.valid, false);
  const report = { admissionOriginBoundsMs: [0, 1], receipts: observer.report };
  assert.doesNotThrow(() => correlateCatalogReceipts(report, { calls: [] }));
  assert.deepEqual(observer.report.launches[0].rpcGroupCandidates, []);
  assert.throws(() => observer.assertValid());
});

test('transition after an early receipt read but before that scan ends remains inside next observation bounds', () => {
  const observer = catalogReceiptObserver({ origin: 0 });
  observer.sample([], { startedAt: 100, endedAt: 110 });
  // Running read at125; validation occurs150 while other receipts are read.
  observer.sample([receipt('running')], { startedAt: 120, endedAt: 180 });
  observer.sample([receipt('validated')], { startedAt: 200, endedAt: 220 });
  // Exit occurs210 AFTER the validated read205, BEFORE prior scan end220.
  observer.sample([receipt('exited')], { startedAt: 240, endedAt: 300 });
  observer.assertValid();
  const row = observer.report.launches[0];
  assert.deepEqual(row.stages, [
    { stage: 'running', afterMs: 100, byMs: 180, scanStartedMs: 120 },
    { stage: 'post-spawn-validated', afterMs: 120, byMs: 220, scanStartedMs: 200 },
    { stage: 'exited', afterMs: 200, byMs: 300, scanStartedMs: 240 },
  ]);
  assert.ok(row.stages[1].afterMs <= 150 && 150 <= row.stages[1].byMs);
  assert.ok(row.stages[2].afterMs <= 210 && 210 <= row.stages[2].byMs);
  const catalog = { admissionOriginBoundsMs: [0, 0], receipts: observer.report };
  correlateCatalogReceipts(catalog, {
    calls: [
      { operation: 'admission-catalog-context', groupId: 7, startedAfterMs: 110, elapsedMs: 105 },
    ],
  });
  assert.deepEqual(row.rpcGroupCandidates, [7]);
  assert.deepEqual(row.commandLifetimeBoundsMs, [20, 200]);
  // Actual running receipt115 to exit210:95ms remains contained. Old prior-END
  // lower bound220 would also falsely exclude the RPC ending215.
  assert.ok(row.commandLifetimeBoundsMs[0] <= 95 && 95 <= row.commandLifetimeBoundsMs[1]);
});

test('absent and unchanged receipt coverage uses scan starts, including fractional time and invalid scan refusal', () => {
  for (const first of [[], [receipt('running')]]) {
    const observer = catalogReceiptObserver({ origin: 0 });
    observer.sample(first, { startedAt: 10.2, endedAt: 30.8 });
    // File absent or version unchanged when checked41; changes50 during scan.
    observer.sample([], { startedAt: 40.2, endedAt: 80.8 });
    observer.sample([receipt('validated')], { startedAt: 90.2, endedAt: 100.8 });
    const stage = observer.report.launches[0].stages.at(-1);
    assert.equal(stage.afterMs, 40);
    assert.equal(stage.byMs, 101);
    assert.ok(stage.afterMs <= 50 && 50 <= stage.byMs);
    observer.assertValid();
  }
  for (const interval of [
    undefined,
    { startedAt: 20, endedAt: 10 },
    { startedAt: NaN, endedAt: 30 },
    { startedAt: 19, endedAt: 30 },
  ]) {
    const observer = catalogReceiptObserver({ origin: 0 });
    observer.sample([], { startedAt: 10, endedAt: 20 });
    observer.sample([receipt('running')], interval);
    assert.equal(observer.report.valid, false);
    assert.throws(() => observer.assertValid());
  }
});
