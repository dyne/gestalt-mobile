/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { editingRemaining } from './live-production-edit-diagnostics.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = () => {
  throw new Error('COLD_CATALOG_EVIDENCE_INVALID');
};

// One original job clock. Setup cannot consume the lifecycle+cleanup reserve;
// observing later never mints another job or expands either allocation.
export function catalogDriverBudget(anchor, phase, now = process.hrtime.bigint()) {
  const left = editingRemaining(anchor, 'cleanup', now);
  assert.ok(['setup', 'observe', 'cleanup'].includes(phase), 'PROOF_DRIVER_PHASE_DEADLINE');
  if (phase === 'observe') {
    assert.ok(left >= 900_000, 'PROOF_DRIVER_PHASE_DEADLINE');
    return 720_000;
  }
  const budget = phase === 'setup' ? Math.min(1_800_000, left - 900_000) : Math.min(180_000, left);
  assert.ok(budget > 0, 'PROOF_DRIVER_PHASE_DEADLINE');
  return budget;
}

// Classification happens before request body decoding. These are preparation
// probes against the fixture's loopback server, never inference permission.
export function catalogProviderProbe(method, path, headers) {
  if (
    headers['transfer-encoding'] !== undefined ||
    (headers['content-length'] !== undefined && headers['content-length'] !== '0')
  )
    fail();
  if (method === 'HEAD' && path === '/v1/responses') return { method, path, status: 405 };
  if (method === 'GET' && path === '/v1/models') return { method, path, status: 200 };
  fail();
}

/** Read-only interval-censored observation of existing authenticated receipts.
 * A receipt does not authorize work. Missing transitions remain missing; samples
 * never replace fresh product checks, invent a worker-ready event or imply the
 * internal Manager passes were timed. */
export function catalogReceiptObserver({ now = () => performance.now(), origin = now() } = {}) {
  const rows = new Map();
  let previousStart = 0,
    previousEnd = origin,
    invalid = false;
  const report = {
    timeBasis: 'process-performance-ms',
    intervalCensored: true,
    workerImportUnobserved: true,
    valid: true,
    launches: [],
  };
  return {
    report,
    sample(receipts, scan) {
      try {
        assert.deepEqual(Object.keys(scan).sort(), ['endedAt', 'startedAt']);
        assert.ok(Number.isFinite(scan.startedAt) && Number.isFinite(scan.endedAt));
        assert.ok(scan.startedAt >= previousEnd && scan.endedAt >= scan.startedAt);
        // The prior read may precede mutations during that prior scan. Its END
        // cannot bound the transition. Floor starts/ceil ends to retain containment.
        const start = Math.floor(scan.startedAt - origin);
        const end = Math.ceil(scan.endedAt - origin);
        for (const { receipt, manifestDigest, generation, captureId } of receipts) {
          assert.match(
            receipt.launchId,
            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
          );
          assert.ok(Number.isSafeInteger(generation) && generation > 0);
          assert.ok(typeof captureId === 'string' && captureId.length > 0);
          assert.equal(receipt.commandId, 'context-mode-call');
          const id = digest(receipt.launchId),
            binding = digest(JSON.stringify([manifestDigest, generation, captureId]));
          let row = rows.get(id);
          if (!row) {
            assert.ok(rows.size < 32);
            row = {
              launchDigest: id,
              bindingDigest: binding,
              generation,
              captureDigest: digest(captureId),
              stages: [],
            };
            rows.set(id, row);
            report.launches.push(row);
          }
          assert.equal(row.bindingDigest, binding);
          let stage;
          if (receipt.kind === 'authorized-launch') stage = 'authorized';
          else {
            assert.equal(receipt.kind, 'process-launch');
            assert.equal(receipt.policy.manifestDigest, manifestDigest);
            assert.ok(['running', 'exited', 'cleanup-required'].includes(receipt.status));
            assert.ok(Number.isSafeInteger(receipt.process.pid) && receipt.process.pid > 0);
            assert.match(receipt.process.birth, /^[0-9]+$/);
            const birth = digest(JSON.stringify(receipt.process));
            assert.ok(!row.birthDigest || row.birthDigest === birth);
            row.birthDigest = birth;
            stage =
              receipt.status === 'running'
                ? receipt.postSpawnValidated === true
                  ? 'post-spawn-validated'
                  : 'running'
                : receipt.status;
          }
          const order = [
            'authorized',
            'running',
            'post-spawn-validated',
            'exited',
            'cleanup-required',
          ];
          const prior = row.stages.at(-1);
          if (prior?.stage === stage) continue;
          assert.ok(!prior || order.indexOf(stage) > order.indexOf(prior.stage));
          row.stages.push({ stage, afterMs: previousStart, byMs: end, scanStartedMs: start });
        }
        // Empty/unchanged/absent-file scans still advance coverage conservatively.
        previousStart = start;
        previousEnd = scan.endedAt;
      } catch {
        invalid = true;
        report.valid = false;
      }
    },
    assertValid() {
      if (invalid || rows.size === 0) fail();
    },
  };
}

// Exactly one real authenticated Resume. The caller retains original API/raw
// ownership and the existing parent cancellation channel throughout this call.
export async function coldCatalogLifecycle({
  api,
  until,
  prefix,
  original,
  capture,
  source,
  providerCount,
  closeStream,
  signedRevoked,
  assertCurrent,
  report,
}) {
  assertCurrent();
  assert.equal(providerCount(), 0);
  const before = capture(original),
    expectedSource = source();
  closeStream();
  let disconnected;
  await until(
    async () => {
      disconnected = await api('GET', prefix);
      return disconnected.state === 'recoveryRequired';
    },
    'COLD_CATALOG_DISCONNECT_DEADLINE',
    30_000,
  );
  assert.equal(disconnected.liveId, original.liveId);
  assert.ok(disconnected.generation > original.generation);
  await until(signedRevoked, 'COLD_CATALOG_REVOCATION_DEADLINE', 30_000);
  assertCurrent();
  report.resumeInvocations = 1;
  const resumed = await api('POST', `${prefix}/resume`, {
    liveId: disconnected.liveId,
    generation: disconnected.generation,
  });
  assertCurrent();
  assert.equal(resumed.state, 'active');
  assert.equal(resumed.liveId, original.liveId);
  assert.ok(resumed.generation > disconnected.generation);
  const after = capture(resumed);
  assert.deepEqual(after.birth, before.birth);
  assert.deepEqual(after.selection, before.selection);
  assert.equal(after.accountDigest, before.accountDigest);
  assert.notEqual(after.captureId, before.captureId);
  assert.equal(source(), expectedSource);
  assert.equal(providerCount(), 0);
  report.originalGeneration = original.generation;
  report.resumedGeneration = resumed.generation;
  report.sameOriginalBirth = true;
  report.sourceUnchanged = true;
  report.sameSelection = true;
  report.latestCaptureDigest = digest(after.captureId);
  return resumed;
}

export function correlateCatalogReceipts(catalog, admission) {
  const [lo, hi] = catalog.admissionOriginBoundsMs;
  assert.ok(Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi);
  const calls = admission.calls.filter(
    (row) => row.operation === 'admission-catalog-context' && Number.isFinite(row.elapsedMs),
  );
  for (const row of catalog.receipts.launches) {
    const first = row.stages[0],
      last = row.stages.at(-1);
    if (!first || !last) {
      row.rpcGroupCandidates = [];
      continue;
    }
    row.rpcGroupCandidates = [
      ...new Set(
        calls
          .filter(
            (call) =>
              first.byMs >= lo + call.startedAfterMs &&
              last.afterMs <= hi + call.startedAfterMs + call.elapsedMs,
          )
          .map((call) => call.groupId),
      ),
    ];
    const running = row.stages.find((stage) => stage.stage === 'running');
    const exited = row.stages.find((stage) => stage.stage === 'exited');
    if (running && exited)
      row.commandLifetimeBoundsMs = [
        Math.max(0, exited.afterMs - running.byMs),
        Math.max(0, exited.byMs - running.afterMs),
      ];
  }
}

export async function drainCatalogCancellation(raw, close) {
  // Start actual close/Stop cancellation before waiting for raw policy work.
  // Both original obligations remain joined, even when close itself refuses.
  const results = await Promise.allSettled([...raw, Promise.resolve().then(close)]);
  const closing = results.at(-1);
  if (closing.status === 'rejected') throw new Error('COLD_CATALOG_CLEANUP_UNVERIFIED');
}

export function validateColdCatalog(report, identity) {
  assert.equal(report.provenance.head, identity.candidate);
  assert.equal(report.provenance.tree, identity.tree);
  for (const key of ['manager', 'managerTree', 'agents'])
    assert.equal(report.provenance[key], identity[key]);
  assert.equal(report.nativeBinarySha256, identity.native);
  assert.equal(report.sourceInventory.signatureVerified, true);
  assert.equal(report.sourceInventory.captureGenerationMatchesLiveGeneration, true);
  assert.equal(report.proofKind, 'cold-catalog-diagnostic');
  assert.equal(report.passed, true);
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.cleanupStage, 'settled');
  assert.equal(report.disposableTreeRemoved, true);
  assert.equal(report.provider.requestCount, 0);
  assert.equal(report.coldCatalog.inferenceRefusals, 0);
  assert.equal(report.coldCatalog.trialId, 'cold-catalog-baseline-1');
  assert.equal(report.coldCatalog.attempt, 1);
  assert.ok(/^[0-9]{1,24}$/.test(report.coldCatalog.actionFinishedNs));
  assert.ok(
    BigInt(report.coldCatalog.actionFinishedNs) <= BigInt(report.coldCatalog.bound.deadlineNs),
  );
  assert.equal(report.coldCatalog.fullAcceptance, false);
  assert.equal(report.coldCatalog.resumeInvocations, 1);
  assert.ok(
    Number.isSafeInteger(report.coldCatalog.originalGeneration) &&
      report.coldCatalog.originalGeneration > 0,
  );
  assert.ok(report.coldCatalog.resumedGeneration > report.coldCatalog.originalGeneration);
  for (const key of [
    'sameOwningNativeBirth',
    'originalCatalog11',
    'terminalPresealZeroTools',
    'actualPostsealCatalog7And12',
    'currentSignedPostSpawnProbe',
    'actualProductionStartActive',
  ])
    assert.equal(report.preflight[key], true);
  assert.equal(report.preflightSeedSkipped, true);
  assert.ok(
    Array.isArray(report.coldCatalog.preparationProbes) &&
      report.coldCatalog.preparationProbes.length <= 2,
  );
  for (const row of report.coldCatalog.preparationProbes) {
    assert.deepEqual(catalogProviderProbe(row.method, row.path, {}), {
      method: row.method,
      path: row.path,
      status: row.status,
    });
    assert.ok(Number.isSafeInteger(row.count) && row.count > 0 && row.count <= 64);
  }
  for (const key of [
    'exactInstalledPreparedBytes',
    'originalManagedOwnerRetainedWithSignedV2Sources',
    'productionContextNativeAdmissionProbe',
    'sameSessionReuseNoReplacement',
  ])
    assert.equal(report.checks[key], true);
  for (const key of [
    'sameOriginalBirth',
    'sourceUnchanged',
    'sameSelection',
    'restorationVerified',
  ])
    assert.equal(report.coldCatalog[key], true);
  assert.equal(report.coldCatalog.receipts.valid, true);
  assert.ok(
    report.coldCatalog.receipts.launches.some(
      (row) =>
        row.generation === report.coldCatalog.resumedGeneration &&
        row.rpcGroupCandidates?.length === 1 &&
        Array.isArray(row.commandLifetimeBoundsMs) &&
        row.commandLifetimeBoundsMs.length === 2 &&
        row.commandLifetimeBoundsMs.every((value) => Number.isFinite(value) && value >= 0) &&
        row.commandLifetimeBoundsMs[1] >= row.commandLifetimeBoundsMs[0] &&
        row.stages.some((stage) => stage.stage === 'post-spawn-validated') &&
        row.stages.some((stage) => stage.stage === 'exited'),
    ),
  );
  for (const key of ['shutdownFailure', 'disposableCleanupFailure', 'failure'])
    assert.equal(report[key], undefined);
  return { diagnosticOnly: true, fullAcceptance: false, identity, cleanupComplete: true };
}
