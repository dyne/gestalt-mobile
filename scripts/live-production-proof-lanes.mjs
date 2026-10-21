/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Test orchestration only. No receipt, configuration or product authority is
// manufactured here. Every production lane owns a fresh authentic fixture.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { catalogDriverBudget } from './live-production-cold-catalog.mjs';
import { proofMode, validateSmokeEvidence } from './live-picker-smoke.mjs';
import {
  editingRemaining,
  editingSchedule,
  requireEditingBudget,
  validateSerialProfile,
} from './live-production-edit-diagnostics.mjs';

export function readEditingAnchor(path, original) {
  const anchor = privateJson(path);
  assert.deepEqual(Object.keys(anchor).sort(), ['boot', 'monotonicNs']);
  assert.equal(anchor.boot, processBirth().boot, 'PROOF_BIRTH_CHANGED');
  editingRemaining(anchor, 'job');
  if (original) assert.deepEqual(anchor, original, 'PROOF_DRIVER_METADATA_CHANGED');
  return anchor;
}

// Parent-owned test deadlines use the runner's single monotonic clock. These
// values are metadata, never Live authority or a renewed product lease.
const phaseAllocation = { accepted: 1_260_000, action: 1_020_000 };
export function editingPhaseBound(anchor, phase, now = process.hrtime.bigint()) {
  assert.ok(Object.hasOwn(phaseAllocation, phase), 'PROOF_EDIT_CLOCK_INVALID');
  editingRemaining(anchor, phase, now);
  const global = BigInt(anchor.monotonicNs) + BigInt(editingSchedule[phase]) * 1_000_000n;
  const local = now + BigInt(phaseAllocation[phase]) * 1_000_000n;
  const result = {
    phase,
    startedNs: now.toString(),
    deadlineNs: (local < global ? local : global).toString(),
  };
  assert.ok(BigInt(result.deadlineNs) > now, 'PROOF_DRIVER_PHASE_DEADLINE');
  return result;
}
export function validateEditingPhaseBound(bound, anchor, phase, now = process.hrtime.bigint()) {
  assert.deepEqual(
    Object.keys(bound).sort(),
    ['deadlineNs', 'phase', 'startedNs'],
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  assert.ok(
    /^[0-9]{1,24}$/.test(bound.startedNs) && /^[0-9]{1,24}$/.test(bound.deadlineNs),
    'PROOF_EDIT_CLOCK_INVALID',
  );
  assert.ok(BigInt(bound.startedNs) <= now, 'PROOF_EDIT_CLOCK_INVALID');
  assert.deepEqual(
    bound,
    editingPhaseBound(anchor, phase, BigInt(bound.startedNs)),
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  return bound;
}
export function mintEditingStep(directory, identity, anchor, now = process.hrtime.bigint()) {
  privateDirectory(directory, true);
  assert.equal(anchor.boot, processBirth().boot, 'PROOF_BIRTH_CHANGED');
  const record = {
    schemaVersion: 1,
    identity,
    anchor,
    phaseA: editingPhaseBound(anchor, 'accepted', now),
  };
  writeFileSync(join(directory, 'phase-a-step.json'), JSON.stringify(record), {
    mode: 0o600,
    flag: 'wx',
  });
  return record;
}
export function readEditingStep(
  directory,
  identity,
  anchor,
  setupRequired = false,
  now = process.hrtime.bigint(),
) {
  privateDirectory(directory);
  const record = privateJson(join(directory, 'phase-a-step.json'));
  assert.deepEqual(Object.keys(record).sort(), ['anchor', 'identity', 'phaseA', 'schemaVersion']);
  assert.equal(record.schemaVersion, 1);
  assertIdentity(record.identity, identity);
  assert.deepEqual(record.anchor, anchor, 'PROOF_DRIVER_METADATA_CHANGED');
  assert.equal(record.anchor.boot, processBirth().boot, 'PROOF_BIRTH_CHANGED');
  validateEditingPhaseBound(record.phaseA, anchor, 'accepted', now);
  assert.ok(phaseBoundRemaining(record.phaseA, now) > 0, 'PROOF_DRIVER_PHASE_DEADLINE');
  if (setupRequired)
    assert.deepEqual(
      privateJson(join(directory, 'setup-complete.json')),
      record,
      'PROOF_DRIVER_METADATA_CHANGED',
    );
  return record;
}
export function completeEditingSetup(directory, identity, anchor, now = process.hrtime.bigint()) {
  const record = readEditingStep(directory, identity, anchor, false, now);
  writeFileSync(join(directory, 'setup-complete.json'), JSON.stringify(record), {
    mode: 0o600,
    flag: 'wx',
  });
  return record;
}
export function claimEditingLaunch(directory, identity, anchor, now = process.hrtime.bigint()) {
  const record = readEditingStep(directory, identity, anchor, true, now);
  writeFileSync(join(directory, 'launch-claim.json'), JSON.stringify(record), {
    mode: 0o600,
    flag: 'wx',
  });
  return { anchor: record.anchor, phaseA: record.phaseA };
}
export function mintCatalogObservation(
  directory,
  identity,
  birth,
  anchor,
  now = process.hrtime.bigint(),
) {
  privateDirectory(directory);
  catalogDriverBudget(anchor, 'observe', now);
  const record = {
    identity,
    birth,
    anchor,
    startedNs: now.toString(),
    deadlineNs: (now + 720_000_000_000n).toString(),
  };
  writeFileSync(join(directory, 'catalog-observation.json'), JSON.stringify(record), {
    mode: 0o600,
    flag: 'wx',
  });
  return record;
}
export function readCatalogObservation(
  directory,
  identity,
  birth,
  original,
  now = process.hrtime.bigint(),
) {
  const record = privateJson(join(directory, 'catalog-observation.json'));
  assert.deepEqual(Object.keys(record).sort(), [
    'anchor',
    'birth',
    'deadlineNs',
    'identity',
    'startedNs',
  ]);
  assertIdentity(record.identity, identity);
  assert.deepEqual(record.birth, birth, 'PROOF_BIRTH_CHANGED');
  assert.equal(record.anchor.boot, birth.boot, 'PROOF_BIRTH_CHANGED');
  assert.ok(
    /^[0-9]{1,24}$/.test(record.startedNs) && /^[0-9]{1,24}$/.test(record.deadlineNs),
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  assert.ok(BigInt(record.startedNs) <= now, 'PROOF_DRIVER_METADATA_CHANGED');
  catalogDriverBudget(record.anchor, 'observe', BigInt(record.startedNs));
  assert.equal(
    BigInt(record.deadlineNs),
    BigInt(record.startedNs) + 720_000_000_000n,
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  if (original) assert.deepEqual(record, original, 'PROOF_DRIVER_METADATA_CHANGED');
  return record;
}
export function phaseBoundRemaining(bound, now = process.hrtime.bigint()) {
  return Math.max(0, Number((BigInt(bound.deadlineNs) - now) / 1_000_000n));
}
function validateEditingMetadata(editing) {
  assert.deepEqual(
    Object.keys(editing).sort(),
    ['anchor', 'phaseA'],
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  assert.deepEqual(
    Object.keys(editing.anchor).sort(),
    ['boot', 'monotonicNs'],
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  assert.equal(editing.anchor.boot, processBirth().boot, 'PROOF_BIRTH_CHANGED');
  validateEditingPhaseBound(editing.phaseA, editing.anchor, 'accepted');
}
function continuationBound(directory, expected) {
  if (!existsSync(join(directory, 'continuation.json'))) return null;
  const row = privateJson(join(directory, 'continuation.json'));
  assert.deepEqual(
    Object.keys(row).sort(),
    ['birth', 'identity', 'phaseB'],
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  assertIdentity(row.identity, expected.identity);
  assert.deepEqual(row.birth, expected.birth, 'PROOF_BIRTH_CHANGED');
  validateEditingPhaseBound(row.phaseB, expected.editing.anchor, 'action');
  assert.ok(
    BigInt(row.phaseB.startedNs) >= BigInt(expected.editing.phaseA.startedNs),
    'PROOF_EDIT_CLOCK_INVALID',
  );
  return row.phaseB;
}
export const fixedProofFailure = (error) => {
  const reasons = [
    'PROOF_CANCELLED',
    'PROOF_PROFILE_INVALID',
    'PROOF_DRIVER_PHASE_DEADLINE',
    'PROOF_EDIT_CLOCK_INVALID',
    'PROOF_EDIT_BUDGET_INSUFFICIENT',
    'PROOF_OBSERVATION_DEADLINE',
    'PROOF_HANDOFF_REFUSED',
    'PROOF_DRIVER_METADATA_CHANGED',
    'PROOF_BIRTH_CHANGED',
    'PROOF_IDENTITY_CHANGED',
  ];
  return reasons.includes(error?.message) ? error.message : null;
};

export const fullLanes = Object.freeze([
  'independent',
  'accept-steer',
  'manual-discard',
  'recovery',
]);
export const diagnosticLanes = Object.freeze(['independent', 'picker-diagnostic']);
export const proofPins = Object.freeze({
  native: 'b2730ae901da317bcc5933d9b87de6dfbea3e46a46b64f806e4268fd9a095578',
  manager: 'b95df8ed30a5d3355502a85fabe8e5aa2d75fe415f8ebc68979e2847028dda42',
  managerTree: '349182948619bbbeab892c9884cfb06badf13997',
  agents: '88f8d4c825d5c6fd862ccff2070865a510f1268b',
});
export const independentChecks = Object.freeze({
  native: [
    'hostAdminSocketReachable',
    'actualAcceptedManagedInputs',
    'originalOwningBirthAndSourcesSealed',
    'existingRuntimeInspected',
    'nativeSpawnResponseObserved',
    'nativeSpawnTaskReturned',
    'actualChildRequestReconciled',
    'modelFileEditPermitted',
    'modelPrivateEditDenied',
    'modelPrivateReadNeverReachedProvider',
    'actualModelAndChildSocketAndDaemonDenials',
    'permittedNativeChildInheritedConfinement',
    'sameOwningThreadModelThinkingAndProcess',
    'electedOwnerNativeUnloadAndExit',
    'ownedRuntimeExited',
  ],
  project: [
    'canonicalNativeHelperCommand',
    'separateNamespaces',
    'nativeFilesystemAndHostUnixDenials',
    'knownBrowserTokenCannotCompeteForPoll',
    'fixedPipeHttpRelay',
    'preparedConnectionSingleUse',
    'changedLaunchInputRefused',
    'staleReceiptRevokedHelperSurvives',
    'ownedNamespacesAndDescendantsExited',
  ],
  remote: [
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
  ],
});
export const commonChecks = Object.freeze([
  'exactInstalledPreparedBytes',
  'normalHomeRuntimeSeparateFromDeniedMobileAuth',
  'soleProductionCompositionConstructed',
  'ordinaryInstalledAuxiliaryModelDiscovery',
  'ordinaryInstalledAuxiliarySkillsExcludeDisabledPackages',
  'actualOwningStartupAdmitted',
  'originalStartupMetadataRetainedWithoutDeletion',
  'persistedBaselineWithoutPreAdmissionCommands',
  'actualOriginalSnapshotConfigurationPreserved',
  'actualBroadScratchScopeRemainsGloballyExclusive',
  'policy_receipt.json',
  'admission_receipt.json',
  'disabledPluginMetadataRemainsInSignedOriginalConfig',
  'installedExecutableSourceSeparatelySignedAndSealed',
  'originalManagedOwnerRetainedWithSignedV2Sources',
  'productionContextNativeAdmissionProbe',
  'sameSessionReuseNoReplacement',
  'authenticatedPrivatePipePreviewThroughRealTls',
  'signedRevocationPrecedesOriginalOwnerExit',
  'revokeCloseAndInjectionRestore',
]);
export const modelConfinementChecks = Object.freeze([
  'actualContextMcpCompletedBeforeArtifactValidation',
  'actualModelToolsAndChildInheritedConfinement',
  'nativeModelContextToolConfined',
  'futureControlDenialsAndArtifactCarveouts',
]);
const sharedModelChecks = [
  'actualMobileUiStartWithProductionAuthentication',
  'chatAutopilotOrgWritersRefusedDuringPickerFlow',
  'previewProbeHandedToActualBrowserConnection',
  'helperBearerAbsentFromActualProviderWire',
  'actualMobileUiOpenAuthenticatedRemoteOverlay',
  'sameOwningThreadModelThinkingAndDurableInbox',
];
const modelChecks = [...sharedModelChecks, ...modelConfinementChecks];
export const diagnosticPickerChecks = Object.freeze([
  ...commonChecks,
  ...modelChecks,
  'actualPickerGenerateAcceptWithCanonicalSourceEffect',
]);
export const laneChecks = Object.freeze({
  'accept-steer': [
    ...commonChecks,
    ...modelChecks,
    'actualPickerGenerateAcceptWithCanonicalSourceEffect',
    'actualPickerSteerWithCanonicalHmrEffect',
    'actualBackgroundBeyondEightSecondsPreservesFencing',
  ],
  'manual-discard': [
    ...commonChecks,
    ...sharedModelChecks,
    'actualPickerManualApplyGenerateDiscardWithExactSourceRestoration',
  ],
  recovery: [
    ...commonChecks,
    'sameOwningThreadModelThinkingWithoutModelTurn',
    'productionSurvivorRenewalPreservesOriginalBirthAndSelections',
    'oldCookiesAndStaleResumeCannotRegrant',
    'concurrentProductionResumeHasOneGenerationAndOneOwner',
    'productionReplacementRequiresActualExitAndFreshOwningObservation',
    'concurrentProductionStopRevokesDrainsAndRestoresOriginalConfiguration',
    'noModelTurnOrSourceEditAfterStop',
    'realRegisteredExternalServerSurvivesWithoutAdoption',
  ],
});
// Original full assertions are retained as explicit cross-lane claims. No lane
// claims to have run another lane's actions in its own session.
export const fullAssertionOwners = Object.freeze({
  ...Object.fromEntries(modelConfinementChecks.map((check) => [check, ['accept-steer']])),
  realPickerGenerateSteerManualApplyAcceptDiscard: ['accept-steer', 'manual-discard'],
  canonicalJournalSourceEffectsAndDiscardRestoration: ['manual-discard'],
  actualViteHmrThroughAuthenticatedGateway: ['accept-steer'],
  actualBackgroundBeyondEightSecondsPreservesFencing: ['accept-steer'],
  originalSurvivorReplacementLineageInOneLivingFixture: ['recovery'],
});
export function selectedLanes(selection) {
  const mode = proofMode(selection);
  const message = selection.message ?? '';
  const editing = message.includes('[editing-lanes]');
  if (message.includes('[cold-catalog-diagnostic]')) {
    assert.equal(selection.eventName, 'push');
    assert.ok(message.includes('[full-native]'));
    assert.equal(mode, 'full');
    assert.ok(
      !editing &&
        !message.includes('[serial-accept-profile]') &&
        !message.includes('[seeded-admission]'),
    );
    assert.ok(
      !selection.preflight &&
        !selection.pickerSmoke &&
        !selection.pickerDiagnostic &&
        !selection.independentOnly,
    );
    return {
      mode: 'cold-catalog-diagnostic',
      lanes: ['cold-catalog'],
      verificationScope: 'diagnostic-only',
    };
  }
  if (message.includes('[serial-accept-profile]')) {
    assert.equal(selection.eventName, 'push');
    assert.ok(message.includes('[full-native]'));
    assert.equal(mode, 'full');
    assert.ok(!editing && !message.includes('[seeded-admission]'));
    assert.ok(
      !selection.preflight &&
        !selection.pickerSmoke &&
        !selection.pickerDiagnostic &&
        !selection.independentOnly,
    );
    return { mode, lanes: ['accept-steer'], verificationScope: 'editing-only' };
  }
  if (editing) {
    assert.equal(selection.eventName, 'push');
    assert.ok(selection.message.includes('[full-native]'));
    assert.equal(mode, 'full');
    return { mode, lanes: ['accept-steer', 'manual-discard'], verificationScope: 'editing-only' };
  }
  return {
    mode,
    lanes:
      mode === 'full'
        ? [...fullLanes]
        : mode === 'picker-diagnostic'
          ? [...diagnosticLanes]
          : mode === 'independent-only'
            ? ['independent']
            : [mode],
  };
}
export function productionLane(value = '') {
  assert.ok(
    ['', 'accept-steer', 'manual-discard', 'recovery'].includes(value),
    'PROOF_LANE_INVALID',
  );
  return value;
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export function candidateIdentity() {
  const candidate = git('rev-parse', 'HEAD');
  assert.equal(candidate, process.env.LIVE_PROOF_EXPECTED_HEAD);
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  return {
    candidate,
    tree: git('rev-parse', 'HEAD^{tree}'),
    runId: process.env.GITHUB_RUN_ID,
    ...proofPins,
  };
}
function assertIdentity(actual, expected) {
  assert.deepEqual(actual, expected, 'PROOF_IDENTITY_CHANGED');
}
export function validateEditingContinuity(report) {
  const proof = report.editingContinuity;
  assert.equal(proof.kind, 'continuity-with-explicit-recovery');
  assert.deepEqual(proof.phaseAllocationMs, [1_260_000, 1_020_000, 180_000]);
  assert.equal(proof.resumeDispatches, 1);
  for (const [key, cap] of [
    ['phaseATotalMs', 1260000],
    ['phaseBTotalMs', 1020000],
    ['actionFinishedOffsetMs', 2400000],
    ['cleanupFinishedOffsetMs', 2580000],
  ])
    assert.ok(Number.isFinite(proof[key]) && proof[key] >= 0 && proof[key] <= cap);

  assert.ok(Number.isSafeInteger(proof.originalGeneration) && proof.originalGeneration > 0);
  assert.ok(proof.recoveryGeneration > proof.originalGeneration);
  assert.ok(proof.resumedGeneration > proof.recoveryGeneration);
  assert.match(proof.acceptedSourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(proof.canonicalGenerations, {
    generate: proof.originalGeneration,
    accept: proof.originalGeneration,
    steer: proof.resumedGeneration,
  });
  for (const key of [
    'originalNativeSurvived',
    'genuineBrowserClosed',
    'newSignedCapture',
    'sameNativeThreadSelection',
    'noModelOrSourceReplay',
    'oldCookieDenied',
    'staleGrantDenied',
  ])
    assert.equal(proof[key], true);
  assert.equal(proof.oldCookieDeniedStatus, 401);
  assert.equal(proof.oldCookieDeniedCode, 'LIVE_AUTH_REQUIRED');
  const { phaseA, phaseB } = proof;
  for (const phase of [phaseA, phaseB]) {
    for (const key of [
      'trustedTls',
      'separateBrowserNetwork',
      'separateBrowserMountNamespace',
      'openThroughMobileControls',
      'extraPollOwnerDenied',
    ])
      assert.equal(phase[key], true);
    assert.equal(phase.ignoreHttpsErrors, false);
    assert.equal(phase.genuineProvider, false);
    assert.equal(phase.proofLane, 'accept-steer');
  }
  assert.equal(phaseA.editingPhase, 'accepted');
  assert.equal(phaseA.observedGeneration, proof.originalGeneration);
  assert.equal(phaseA.exchangePosts, 1);
  assert.equal(phaseA.realPickerGenerateAccept, true);
  assert.equal(phaseA.realPickerSteer, false);
  assert.equal(phaseB.editingPhase, 'steer');
  assert.equal(phaseB.observedGeneration, proof.resumedGeneration);
  assert.equal(phaseB.exchangePosts, 1);
  assert.equal(phaseB.realPickerGenerateAccept, false);
  assert.equal(phaseB.realPickerSteer, true);
  assert.equal(phaseB.actualTabHiddenBeyondEightSeconds, true);
  assert.ok(phaseB.hmrUpdates > 0);
  for (const key of ['freshDocumentHelperConnected', 'visibleChrome', 'acceptedHeading'])
    assert.equal(phaseB.postResumeContinuity[key], true);
  assert.ok(
    Number.isSafeInteger(phaseB.postResumeContinuity.elapsedMs) &&
      phaseB.postResumeContinuity.elapsedMs >= 0 &&
      phaseB.postResumeContinuity.elapsedMs <= 30_000,
  );
  assert.equal(report.recoveryHandoff.continuations, 1);
  assert.equal(report.recoveryHandoff.cancelled, false);
  assert.equal(report.recoveryHandoff.sameDriverBirth, true);
}
export function validateProductionLane(lane, report, identity) {
  if (report.serialProfileTrialRequested !== undefined || report.serialProfile !== undefined) {
    assert.equal(lane, 'accept-steer');
    assert.equal(report.serialProfileTrialRequested, true);
    assert.equal(report.serialProfileValid, true);
    validateSerialProfile(report.serialProfile);
    assert.equal(
      report.serialProfile.originalOwner.generation,
      report.editingContinuity.originalGeneration,
    );
    assertIdentity(report.serialProfile.binding.identity, identity);
    assert.equal(
      report.recoveryHandoff.birthDigest,
      digest(Buffer.from(JSON.stringify(report.serialProfile.binding.birth))),
    );
  }
  assert.ok(laneChecks[lane], 'PROOF_LANE_INVALID');
  assert.equal(report.passed, true);
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.productionLane, lane);
  assert.equal(report.provenance.head, identity.candidate);
  assert.equal(report.provenance.tree, identity.tree);
  for (const key of ['manager', 'managerTree', 'agents'])
    assert.equal(report.provenance[key], identity[key]);
  assert.equal(report.nativeBinarySha256, identity.native);
  assert.equal(report.sourceInventory.signatureVerified, true);
  assert.equal(report.sourceInventory.captureGenerationMatchesLiveGeneration, true);
  for (const check of laneChecks[lane])
    assert.equal(report.checks[check], true, `PROOF_CHECK_MISSING:${check}`);
  assert.ok(Object.values(report.checks).every((value) => value === true));
  if (lane === 'manual-discard') {
    assert.equal(report.modelWorkload, 'owning-edit-only');
    for (const check of modelConfinementChecks)
      assert.equal(Object.hasOwn(report.checks, check), false);
    assert.equal(report.provider.contextProtocol, undefined);
    assert.equal(report.provider.spawnResponse, undefined);
    assert.equal(report.nativeActivity?.files > 1, false);
  }
  if (lane !== 'recovery') {
    const required =
      lane === 'accept-steer'
        ? ['generate', 'accept', 'steer']
        : ['manual_edit_apply', 'generate', 'discard'];
    assert.deepEqual(
      report.laneCanonicalEvents,
      required.map((kind) => ({
        kind,
        stage: 'acknowledged',
        history: ['received', 'dispatched', 'applied', 'acknowledged'],
      })),
    );
    const browser = report.editBrowser;
    assert.equal(browser.proofLane, lane);
    for (const check of [
      'trustedTls',
      'separateBrowserNetwork',
      'separateBrowserMountNamespace',
      'openThroughMobileControls',
      'extraPollOwnerDenied',
    ])
      assert.equal(browser[check], true);
    assert.equal(browser.ignoreHttpsErrors, false);
    assert.equal(browser.genuineProvider, false);
    if (lane === 'accept-steer') {
      validateEditingContinuity(report);
      assert.equal(browser.realPickerGenerateAccept, true);
      assert.equal(browser.realPickerSteer, true);
      assert.equal(browser.actualTabHiddenBeyondEightSeconds, true);
      assert.ok(browser.hmrUpdates > 0);
      assert.equal(browser.realPickerManualApply, false);
      assert.equal(browser.realPickerDiscard, false);
    } else {
      assert.equal(browser.realPickerManualApply, true);
      assert.equal(browser.realPickerDiscard, true);
      for (const observation of [
        report.manualPollObservation,
        report.manualPollCommitObservation,
      ]) {
        for (const key of [
          'commandIpcDispatched',
          'workerBirthsCurrent',
          'postAuthority',
          'pending',
          'generationMatches',
        ])
          assert.equal(observation[key], true);
        assert.equal(observation.foregroundChildBirthObserved, false);
        assert.ok(Number.isSafeInteger(observation.sequence) && observation.sequence > 0);
      }
      assert.equal(
        report.manualPollObservation.sequence,
        report.manualPollCommitObservation.sequence,
      );
      const timing = report.manualAcknowledgementObservation;
      for (const key of [
        'commitAccepted',
        'canonicalAcknowledged',
        'entryAndEventCorrelated',
        'within120sMargin',
      ])
        assert.equal(timing[key], true);
      assert.ok(
        Number.isSafeInteger(timing.enqueueToAckUpperBoundMs) &&
          timing.enqueueToAckUpperBoundMs >= 0 &&
          timing.enqueueToAckUpperBoundMs <= 120_000,
      );
      assert.ok(
        Number.isSafeInteger(timing.requestStartToAcceptedMs) &&
          timing.requestStartToAcceptedMs >= 0 &&
          timing.requestStartToAcceptedMs <= timing.enqueueToAckUpperBoundMs,
      );
      assert.equal(browser.realPickerGenerateAccept, false);
      assert.equal(browser.realPickerSteer, false);
    }
  }
  if (lane === 'recovery') {
    const chain = report.recovery;
    assert.equal(chain.originalBirthPreservedDuringSurvivor, true);
    assert.equal(chain.replacementBirthAfterActualExit, true);
    assert.equal(chain.originalManifestBytesPreserved, true);
    assert.equal(chain.durableInboxRemainsSharedAcrossGenerations, true);
    assert.equal(new Set(chain.captures).size, 3);
    assert.equal(chain.generations.length, 5);
    assert.ok(
      chain.generations.every((g, i, all) => Number.isSafeInteger(g) && (!i || g > all[i - 1])),
    );
    assert.equal(report.recoveryHandoff.continuations, 1);
    assert.equal(report.recoveryHandoff.cancelled, false);
    assert.equal(report.recoveryHandoff.sameDriverBirth, true);
  }
}
/** Fresh independent evidence is required by the aggregate, never borrowed from
 * historical smoke eligibility or interpreted as product dispatch authority. */
export function validateDiagnosticPicker(report, identity) {
  assert.equal(report.passed, true);
  assert.equal(report.cleanupComplete, true);
  assert.equal(report.disposableTreeRemoved, true);
  assert.equal(report.productionLane, undefined);
  assert.equal(report.proofKind, 'actual-picker-current-independent-diagnostic');
  assert.equal(report.independentEvidenceReuse, undefined);
  assert.deepEqual(report.pickerDiagnostic, {
    mode: 'picker-diagnostic',
    diagnosticOnly: true,
    fullExactCandidateStillRequired: true,
    identity,
  });
  assert.equal(report.provenance.head, identity.candidate);
  assert.equal(report.provenance.tree, identity.tree);
  for (const key of ['manager', 'managerTree', 'agents'])
    assert.equal(report.provenance[key], identity[key]);
  assert.equal(report.nativeBinarySha256, identity.native);
  assert.equal(report.sourceInventory.signatureVerified, true);
  assert.equal(report.sourceInventory.captureGenerationMatchesLiveGeneration, true);
  assert.deepEqual(Object.keys(report.checks).sort(), [...diagnosticPickerChecks].sort());
  assert.ok(Object.values(report.checks).every((v) => v === true));
  const browser = report.editBrowser;
  for (const key of [
    'trustedTls',
    'separateBrowserNetwork',
    'separateBrowserMountNamespace',
    'openThroughMobileControls',
    'extraPollOwnerDenied',
    'realPickerGenerateAccept',
    'pickerSmoke',
  ])
    assert.equal(browser[key], true);
  for (const key of [
    'ignoreHttpsErrors',
    'genuineProvider',
    'realPickerSteer',
    'realPickerManualApply',
    'realPickerDiscard',
    'actualTabHiddenBeyondEightSeconds',
  ])
    assert.equal(browser[key], false);
  assert.deepEqual(
    report.laneCanonicalEvents,
    ['generate', 'accept'].map((kind) => ({
      kind,
      stage: 'acknowledged',
      history: ['received', 'dispatched', 'applied', 'acknowledged'],
    })),
  );
  assert.deepEqual(
    report.pickerObservations.map((v) => v.boundary),
    ['before-accept', 'after-accept', 'after-accept-ack'],
  );
  assert.ok(report.pickerObservations.every((v) => v.available === true));
  for (const snapshot of report.pickerObservations) {
    assert.ok(Number.isSafeInteger(snapshot.navigationCount) && snapshot.navigationCount >= 0);
    assert.equal(typeof snapshot.pageChatInDocument, 'boolean');
    assert.equal(typeof snapshot.globalBar.present, 'boolean');
    assert.equal(typeof snapshot.pageChat.present, 'boolean');
  }
  assert.ok(
    Number.isSafeInteger(report.startAdmissionElapsedMs) && report.startAdmissionElapsedMs > 0,
  );
  const authorityRows = report.eventAuthorityTimings;
  assert.ok(Array.isArray(authorityRows) && authorityRows.length > 0 && authorityRows.length <= 64);
  for (const phase of ['event-turn', 'canonical-poll'])
    assert.ok(authorityRows.some((row) => row.phase === phase && row.completed === true));
  let authorityObservation = 'all-observed-boundaries-completed';
  for (const [index, row] of authorityRows.entries()) {
    assert.ok(['canonical-poll', 'event-turn'].includes(row.phase));
    assert.ok(Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0);
    if (row.completed === true) {
      assert.ok(Number.isSafeInteger(row.grantedAfterMs) && row.grantedAfterMs >= 0);
      assert.ok(row.elapsedMs >= row.grantedAfterMs);
      continue;
    }
    // This is an observation of nonauthorization, never proof of its cause or
    // of drainage. Independent signed and physical closure evidence is required.
    assert.equal(row.completed, false);
    assert.equal(index, authorityRows.length - 1);
    assert.equal(row.phase, 'canonical-poll');
    assert.equal(row.grantedAfterMs, null);
    assert.equal(report.cleanupStage, 'settled');
    assert.equal(report.shutdownFailure, undefined);
    assert.equal(report.disposableCleanupFailure, undefined);
    assert.ok(Array.isArray(report.cleanupOperations) && report.cleanupOperations.length <= 64);
    assert.ok(report.cleanupOperations.every((v) => v.result === 'completed'));
    for (const operation of [
      'controller-close',
      'signed-revoke',
      'poll-drain',
      'poll-settle',
      'owning-abort',
    ])
      assert.ok(
        report.cleanupOperations.some((v) => v.operation === operation && v.result === 'completed'),
      );
    const owners = report.nativeLaunchLifetimes.filter((v) => v.capturedOwner === true);
    assert.equal(owners.length, 1);
    assert.equal(owners[0].exitCode, 0);
    assert.equal(owners[0].signal, null);
    assert.equal(owners[0].exitVerified, true);
    assert.equal(owners[0].treeFailures, 0);
    assert.equal(report.cleanupProjectClosure.length, 2);
    for (const role of ['helper', 'devserver']) {
      const processes = report.cleanupProjectClosure.filter((v) => v.role === role);
      assert.equal(processes.length, 1);
      assert.equal(processes[0].namespaceExited, true);
      assert.equal(processes[0].pipeDescriptorsClosed, true);
    }
    authorityObservation = 'terminal-nonauthorizing-interruption';
  }
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
  ]) {
    const timings = report[field];
    assert.ok(
      Array.isArray(timings.calls) && timings.calls.length > 0 && timings.calls.length <= 512,
    );
    for (const row of timings.calls) {
      assert.ok(labels.includes(row.operation));
      assert.ok(['completed', 'failed'].includes(row.result));
      for (const key of ['groupId', 'startedAfterMs', 'elapsedMs'])
        assert.ok(Number.isSafeInteger(row[key]) && row[key] >= 0);
    }
    assert.deepEqual(Object.keys(timings.counters).sort(), [...labels].sort());
    for (const counter of Object.values(timings.counters)) {
      assert.ok(Number.isSafeInteger(counter.started) && counter.started > 0);
      for (const key of ['completed', 'failed', 'totalMs'])
        assert.ok(Number.isSafeInteger(counter[key]) && counter[key] >= 0);
      assert.equal(counter.started, counter.completed + counter.failed);
    }
  }
  return authorityObservation;
}
const independentFiles = [
  'native-model-tools/native-model-tools-proof.json',
  'remote-proof.json',
  'vitest.json',
  'cleanup-proof.json',
  'project-isolation/project-isolation-proof.json',
];
const laneFiles = (lane) =>
  lane === 'independent'
    ? independentFiles
    : [
        'production-entrypoint/production-entrypoint-proof.json',
        ...(lane === 'recovery'
          ? ['recovery-driver-cleanup.json']
          : lane === 'accept-steer'
            ? ['editing-driver-cleanup.json']
            : []),
      ];
function validateDriverCleanup(report, identity) {
  assertIdentity(report.identity, identity);
  assert.equal(report.driverExited, true);
  assert.equal(report.cancelSent, false);
  assert.notEqual(report.cancelAttempted, true);
  assert.equal(report.failure, undefined);
}
function validateEditingDriverCleanup(cleanup, report, identity) {
  validateDriverCleanup(cleanup, identity);
  assert.equal(cleanup.finalDriverVerified, true);
  assert.equal(
    report.recoveryHandoff.birthDigest,
    digest(Buffer.from(JSON.stringify(cleanup.birth))),
  );
}
export function loadLanePacket(directory) {
  const read = (file) => {
    let path = directory;
    const parts = file.split('/');
    for (const [i, part] of parts.entries()) {
      assert.ok(part !== '.' && part !== '..' && part !== '');
      path = join(path, part);
      const info = lstatSync(path);
      assert.ok(!info.isSymbolicLink());
      assert.ok(
        i === parts.length - 1
          ? info.isFile() && info.size <= 16 * 1024 * 1024
          : info.isDirectory(),
      );
    }
    return readFileSync(path);
  };
  const receipt = JSON.parse(read('lane-receipt.json'));
  assert.ok([...fullLanes, 'picker-diagnostic'].includes(receipt.lane));
  assert.deepEqual(Object.keys(receipt.reports).sort(), [...laneFiles(receipt.lane)].sort());
  return {
    receipt,
    reports: Object.fromEntries(laneFiles(receipt.lane).map((file) => [file, read(file)])),
  };
}
export function writeLaneReceipt(
  lane,
  directory,
  identity = candidateIdentity(),
  mode = 'full',
  verificationScope,
  serialProfileTrial = false,
) {
  assert.ok(verificationScope === undefined || verificationScope === 'editing-only');
  if (verificationScope) {
    assert.equal(mode, 'full');
    assert.ok(['accept-steer', 'manual-discard'].includes(lane));
  }
  assert.ok(['full', 'picker-diagnostic', 'independent-only'].includes(mode));
  assert.ok(
    (mode === 'full'
      ? fullLanes
      : mode === 'picker-diagnostic'
        ? diagnosticLanes
        : ['independent']
    ).includes(lane),
  );
  if (serialProfileTrial) {
    assert.equal(lane, 'accept-steer');
    assert.equal(mode, 'full');
    assert.equal(verificationScope, 'editing-only');
  }
  const files = laneFiles(lane);
  const reports = Object.fromEntries(files.map((file) => [file, json(join(directory, file))]));
  if (serialProfileTrial) assert.equal(reports[files[0]].serialProfileTrialRequested, true);
  if (lane === 'independent') validateIndependent(reports, identity);
  else if (lane === 'picker-diagnostic') validateDiagnosticPicker(reports[files[0]], identity);
  else {
    validateProductionLane(lane, reports[files[0]], identity);
    if (lane === 'recovery')
      validateDriverCleanup(reports['recovery-driver-cleanup.json'], identity);
    if (lane === 'accept-steer')
      validateEditingDriverCleanup(
        reports['editing-driver-cleanup.json'],
        reports[files[0]],
        identity,
      );
  }
  const receipt = {
    schemaVersion: 1,
    lane,
    identity,
    ...(verificationScope
      ? {
          verificationScope,
          partialL11EditingEvidence: true,
          fullExactCandidateStillRequired: true,
        }
      : {}),
    ...(mode === 'picker-diagnostic'
      ? { mode, diagnosticOnly: true, fullExactCandidateStillRequired: true }
      : mode === 'independent-only'
        ? { mode, partialL11AdmissionEvidence: true, fullExactCandidateStillRequired: true }
        : {}),
    ...(serialProfileTrial
      ? { profilingTrial: reports[files[0]].serialProfile.binding.trialId }
      : {}),
    passed: true,
    cleanupComplete: true,
    reports: Object.fromEntries(
      files.map((file) => [file, digest(readFileSync(join(directory, file)))]),
    ),
  };
  writeJson(join(directory, 'lane-receipt.json'), receipt);
  return receipt;
}
function validateIndependent(reports, identity) {
  const [native, remote, tests, cleanup, project] = independentFiles.map((file) => reports[file]);
  validateSmokeEvidence({ native, remote, tests, cleanup });
  for (const key of independentChecks.native) assert.equal(native.checks[key], true);
  for (const key of independentChecks.project) assert.equal(project.checks[key], true);
  for (const key of independentChecks.remote) assert.equal(remote[key], true);
  assert.equal(native.provenance.mobileHead, identity.candidate);
  assert.equal(native.provenance.expectedHead, identity.candidate);
  assert.equal(native.provenance.mobileTree, identity.tree);
  assert.equal(native.provenance.binarySha256, identity.native);
  assert.equal(project.provenance.head, identity.candidate);
  assert.equal(project.provenance.tree, identity.tree);
  assert.equal(project.provenance.native, identity.native);
  assert.equal(project.passed, true);
  assert.equal(project.cleanupComplete, true);
  assert.ok(Object.values(project.checks).every((value) => value === true));
}
export function aggregateLanes(packets, identity) {
  assert.deepEqual(Object.keys(packets).sort(), [...fullLanes].sort(), 'PROOF_LANES_INCOMPLETE');
  const validated = new Map();
  for (const lane of fullLanes) {
    const { receipt, reports } = packets[lane];
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.lane, lane);
    assert.equal(receipt.mode, undefined);
    assert.equal(receipt.profilingTrial, undefined);
    assert.equal(receipt.verificationScope, undefined);
    assert.equal(receipt.partialL11EditingEvidence, undefined);
    assert.equal(receipt.diagnosticOnly, undefined);
    assertIdentity(receipt.identity, identity);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.cleanupComplete, true);
    const files = laneFiles(lane);
    assert.deepEqual(Object.keys(receipt.reports).sort(), [...files].sort());
    assert.deepEqual(Object.keys(reports).sort(), [...files].sort());
    for (const file of files) {
      const bytes = reports[file];
      assert.equal(digest(bytes), receipt.reports[file], 'PROOF_REPORT_CHANGED');
    }
    const parsed = Object.fromEntries(files.map((file) => [file, JSON.parse(reports[file])]));
    validated.set(lane, parsed[files[0]]);
    if (lane === 'independent') validateIndependent(parsed, identity);
    else {
      validateProductionLane(lane, parsed[files[0]], identity);
      if (lane === 'recovery')
        validateDriverCleanup(parsed['recovery-driver-cleanup.json'], identity);
      if (lane === 'accept-steer')
        validateEditingDriverCleanup(
          parsed['editing-driver-cleanup.json'],
          parsed[files[0]],
          identity,
        );
    }
  }
  // Resolve direct claims only from the actual validated current owner report.
  for (const check of modelConfinementChecks) {
    assert.deepEqual(fullAssertionOwners[check], ['accept-steer']);
    assert.equal(validated.get('accept-steer').checks[check], true);
  }
  return {
    schemaVersion: 1,
    passed: true,
    cleanupComplete: true,
    identity,
    proofKind: 'complete-controlled-integration-across-fresh-owning-lanes',
    crossLaneEvidence: true,
    genuineProvider: false,
    originalHookedEnabledHomeProven: false,
    fullAssertionOwners,
    laneChecks,
    independentChecks,
    checks: Object.fromEntries(
      [...new Set([...Object.keys(fullAssertionOwners), ...Object.values(laneChecks).flat()])].map(
        (key) => [key, true],
      ),
    ),
    limitations: [
      'Controlled provider only.',
      'Original unchanged hooks/enabled Gestalt and genuine provider remain unproven.',
      'Actions span explicit fresh owning lanes; recovery lineage remains one living fixture.',
    ],
  };
}

// Recovery phase handoff: the fixture stays alive; only one test continuation
// is released. Nothing in this protocol grants or reconstructs Live authority.
export function processBirth(pid = process.pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'PROOF_BIRTH_INVALID');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  assert.ok(fields[0] !== 'Z' && /^[0-9]+$/.test(fields[19]), 'PROOF_BIRTH_EXITED');
  return {
    pid,
    start: fields[19],
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  };
}
export function birthCurrent(birth) {
  try {
    return isDeepStrictEqual(processBirth(birth.pid), birth);
  } catch {
    return false;
  }
}
export function aggregateDiagnostic(packets, identity) {
  assert.deepEqual(
    Object.keys(packets).sort(),
    [...diagnosticLanes].sort(),
    'DIAGNOSTIC_LANES_INCOMPLETE',
  );
  let authorityObservation;
  for (const lane of diagnosticLanes) {
    const { receipt, reports } = packets[lane];
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.lane, lane);
    assert.equal(receipt.mode, 'picker-diagnostic');
    assert.equal(receipt.diagnosticOnly, true);
    assert.equal(receipt.fullExactCandidateStillRequired, true);
    assertIdentity(receipt.identity, identity);
    assert.equal(receipt.passed, true);
    assert.equal(receipt.cleanupComplete, true);
    const files = laneFiles(lane);
    assert.deepEqual(Object.keys(receipt.reports).sort(), [...files].sort());
    assert.deepEqual(Object.keys(reports).sort(), [...files].sort());
    for (const file of files)
      assert.equal(digest(reports[file]), receipt.reports[file], 'PROOF_REPORT_CHANGED');
    const parsed = Object.fromEntries(files.map((file) => [file, JSON.parse(reports[file])]));
    if (lane === 'independent') validateIndependent(parsed, identity);
    else authorityObservation = validateDiagnosticPicker(parsed[files[0]], identity);
  }
  return {
    schemaVersion: 1,
    passed: true,
    cleanupComplete: true,
    identity,
    proofKind: 'exact-candidate-picker-diagnostic-with-independent-proofs',
    authorityObservation,
    diagnosticOnly: true,
    fullAcceptance: false,
    fullExactCandidateStillRequired: true,
    crossLaneEvidence: true,
    lanes: [...diagnosticLanes],
    independentChecks,
    diagnosticPickerChecks,
    unprovenActions: ['steer', 'manual-apply', 'discard', 'background', 'recovery'],
    genuineProvider: false,
    originalHookedEnabledHomeProven: false,
  };
}

function privateDirectory(directory, create = false) {
  if (create) mkdirSync(directory, { mode: 0o700 });
  const info = lstatSync(directory);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o077) === 0,
    'PROOF_CHANNEL_UNSAFE',
  );
}
function privateJson(path) {
  const info = lstatSync(path);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o077) === 0 &&
      info.size <= 4096,
    'PROOF_CHANNEL_UNSAFE',
  );
  return json(path);
}
export async function openRecoveryHandoff({
  directory,
  identity,
  onCancel,
  pauseMs = 1_800_000,
  socketDirectory = directory,
  editing,
  onFailure = () => {},
}) {
  assert.ok(
    Number.isFinite(pauseMs) && pauseMs > 0 && pauseMs <= 1_800_000,
    'PROOF_PHASE_BUDGET_INVALID',
  );
  privateDirectory(directory);
  privateDirectory(socketDirectory);
  const birth = processBirth();
  if (editing) {
    editing = structuredClone(editing);
    Object.freeze(editing.anchor);
    Object.freeze(editing.phaseA);
    Object.freeze(editing);
    validateEditingMetadata(editing);
    const launched = privateJson(join(directory, 'launched.json'));
    assert.deepEqual(launched, { identity, birth, editing }, 'PROOF_DRIVER_METADATA_CHANGED');
  }
  let phaseB = null,
    phaseTimer,
    firstFailure;
  const began = performance.now();
  let readyAt, continuedAt;
  let phase = 'setup',
    continuations = 0,
    cancelled = false,
    resume,
    rejectPause;
  let cancellation;
  const snapshot = () => ({
    schemaVersion: editing ? 2 : 1,
    identity,
    birth,
    socketDirectory,
    ...(editing ? { editing, phaseB, firstFailure: firstFailure ?? null } : {}),
    phase,
    continuations,
    cancelled,
    phaseTimings: {
      setupMs: Math.round((readyAt ?? performance.now()) - began),
      pausedMs:
        readyAt === undefined ? 0 : Math.round((continuedAt ?? performance.now()) - readyAt),
      recoveryMs: continuedAt === undefined ? 0 : Math.round(performance.now() - continuedAt),
    },
  });
  const cancel = (reason = 'PROOF_CANCELLED') => {
    if (!cancelled) {
      if (editing) {
        firstFailure ??= fixedProofFailure(new Error(reason)) ?? 'PROOF_CANCELLED';
        onFailure(firstFailure);
      }
      clearTimeout(phaseTimer);
      cancelled = true;
      phase = 'cancelled';
      rejectPause?.(new Error(firstFailure ?? 'PROOF_CANCELLED'));
      cancellation = Promise.resolve().then(onCancel);
      cancellation.catch(() => {});
    }
    return cancellation;
  };
  const armPhase = (bound) => {
    clearTimeout(phaseTimer);
    const left = phaseBoundRemaining(bound);
    if (left <= 0) {
      void cancel('PROOF_DRIVER_PHASE_DEADLINE');
      return;
    }
    phaseTimer = setTimeout(() => void cancel('PROOF_DRIVER_PHASE_DEADLINE'), left);
  };
  const assertCurrent = () => {
    if (
      editing &&
      ['setup', 'recovery'].includes(phase) &&
      phaseBoundRemaining(phaseB ?? editing.phaseA) <= 0
    )
      void cancel('PROOF_DRIVER_PHASE_DEADLINE');
    assert.ok(!cancelled && birthCurrent(birth), firstFailure ?? 'PROOF_CANCELLED');
  };
  if (editing) {
    assertCurrent();
    armPhase(editing.phaseA);
  }
  const server = createServer((socket) => {
    socket.setTimeout(2000, () => socket.destroy());
    let text = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > 4096) return socket.destroy();
      if (!text.endsWith('\n')) return;
      try {
        const request = JSON.parse(text);
        assert.deepEqual(
          Object.keys(request).sort(),
          [
            'birth',
            'command',
            'identity',
            ...(editing && request.command === 'continue' ? ['phaseB'] : []),
          ].sort(),
        );
        assertIdentity(request.identity, identity);
        assert.deepEqual(request.birth, birth);
        assert.ok(birthCurrent(birth));
        if (request.command === 'continue') {
          assert.ok(phase === 'ready' && continuations === 0 && !cancelled);
          if (editing) {
            const bound = continuationBound(directory, { identity, birth, editing });
            assert.ok(bound && phaseBoundRemaining(bound) > 0, 'PROOF_DRIVER_PHASE_DEADLINE');
            assert.deepEqual(request.phaseB, bound, 'PROOF_DRIVER_METADATA_CHANGED');
            phaseB = Object.freeze(bound);
            armPhase(phaseB);
          }
          continuations++;
          phase = 'recovery';
          continuedAt = performance.now();
          resume();
        } else if (request.command === 'cancel') void cancel();
        else assert.equal(request.command, 'status');
        socket.end(JSON.stringify({ ok: true, ...snapshot() }) + '\n');
      } catch {
        socket.end(JSON.stringify({ ok: false, code: 'PROOF_HANDOFF_REFUSED' }) + '\n');
      }
    });
  });
  const path = join(socketDirectory, 'control.sock');
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(path, done);
  });
  chmodSync(path, 0o600);
  writeFileSync(join(directory, 'driver.json'), JSON.stringify(snapshot()) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  return {
    snapshot,
    cancel,
    finishActions() {
      assert.ok(phase === 'recovery' && continuations === 1 && !cancelled);
      assertCurrent();
      phase = 'settling';
      clearTimeout(phaseTimer);
    },
    assertCurrent,
    deadlineNs(phaseName) {
      assert.ok(editing, 'PROOF_EDIT_CLOCK_INVALID');
      const bound = phaseName === 'accepted' ? editing.phaseA : phaseB;
      assert.ok(bound, 'PROOF_HANDOFF_PHASE_INVALID');
      assertCurrent();
      return bound.deadlineNs;
    },
    async boundary() {
      assertCurrent();
      assert.ok(phase === 'setup' && !cancelled, 'PROOF_HANDOFF_PHASE_INVALID');
      clearTimeout(phaseTimer);
      let timer;
      try {
        await new Promise((done, reject) => {
          resume = done;
          rejectPause = reject;
          phase = 'ready';
          readyAt = performance.now();
          timer = setTimeout(() => {
            void cancel();
          }, pauseMs);
        });
      } finally {
        clearTimeout(timer);
        rejectPause = undefined;
      }
      assert.ok(
        continuations === 1 && !cancelled && birthCurrent(birth),
        'PROOF_HANDOFF_PHASE_INVALID',
      );
      assertCurrent();
    },
    async close() {
      if (phase === 'ready') await cancel();
      await cancellation;
      clearTimeout(phaseTimer);
      phase = cancelled ? 'cancelled' : 'complete';
      writeJson(join(directory, 'final-driver.json'), snapshot());
      await new Promise((done) => server.close(done));
    },
  };
}
export function handoffRequest(directory, command, expected, timeoutMs = 2500) {
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2500,
    'PROOF_RPC_BUDGET_INVALID',
  );
  privateDirectory(directory);
  const socketDirectory = expected.socketDirectory ?? directory;
  privateDirectory(socketDirectory);
  const info = lstatSync(join(socketDirectory, 'control.sock'));
  assert.ok(
    info.isSocket() && info.uid === process.getuid() && (info.mode & 0o077) === 0,
    'PROOF_CHANNEL_UNSAFE',
  );
  assert.ok(birthCurrent(expected.birth), 'PROOF_DRIVER_EXITED');
  return new Promise((done, reject) => {
    const socket = createConnection(join(socketDirectory, 'control.sock'));
    let text = '',
      settled = false;
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        reject(new Error(error));
      } else done(response);
    };
    const fail = () => finish('PROOF_HANDOFF_UNAVAILABLE');
    const refuse = () => finish('PROOF_HANDOFF_REFUSED');
    const timer = setTimeout(fail, timeoutMs);
    socket.on('close', () => {
      if (!settled) fail();
    });
    socket.on('error', (error) => {
      if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(error.code)) fail();
      else refuse();
    });
    socket.on('connect', () => {
      try {
        socket.end(
          JSON.stringify({
            command,
            identity: expected.identity,
            birth: expected.birth,
            ...(expected.editing && command === 'continue'
              ? { phaseB: continuationBound(directory, expected) }
              : {}),
          }) + '\n',
        );
      } catch {
        refuse();
      }
    });
    socket.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > 4096) refuse();
    });
    socket.on('end', () => {
      try {
        const response = JSON.parse(text);
        assert.equal(response.ok, true);
        assertIdentity(response.identity, expected.identity);
        assert.deepEqual(response.birth, expected.birth);
        assert.deepEqual(
          Object.keys(response).sort(),
          [
            'ok',
            'schemaVersion',
            'identity',
            'birth',
            'socketDirectory',
            'phase',
            'continuations',
            'cancelled',
            'phaseTimings',
            ...(expected.editing ? ['editing', 'phaseB', 'firstFailure'] : []),
          ].sort(),
        );
        assert.equal(response.schemaVersion, expected.editing ? 2 : 1);
        if (expected.editing) {
          assert.deepEqual(response.editing, expected.editing, 'PROOF_DRIVER_METADATA_CHANGED');
          assert.deepEqual(
            response.phaseB,
            continuationBound(directory, expected),
            'PROOF_DRIVER_METADATA_CHANGED',
          );
          assert.ok(
            response.firstFailure === null ||
              fixedProofFailure(new Error(response.firstFailure)) === response.firstFailure,
          );
        }
        assert.equal(response.socketDirectory, expected.socketDirectory ?? directory);
        assert.ok(
          ['setup', 'ready', 'recovery', 'settling', 'cancelled', 'complete'].includes(
            response.phase,
          ),
        );
        assert.ok([0, 1].includes(response.continuations));
        assert.equal(typeof response.cancelled, 'boolean');
        assert.deepEqual(
          Object.keys(response.phaseTimings).sort(),
          ['setupMs', 'pausedMs', 'recoveryMs'].sort(),
        );
        assert.ok(
          Object.values(response.phaseTimings).every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          ),
        );
        finish(undefined, response);
      } catch {
        refuse();
      }
    });
  });
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const safeFailure = (error) => {
  const reason = error instanceof Error ? error.message.split('\n', 1)[0] : '';
  return new Set([
    'PROOF_HANDOFF_UNAVAILABLE',
    'PROOF_HANDOFF_REFUSED',
    'PROOF_DRIVER_EXITED',
    'PROOF_DRIVER_PHASE_DEADLINE',
    'PROOF_CHANNEL_UNSAFE',
    'PROOF_BIRTH_CHANGED',
    'PROOF_IDENTITY_CHANGED',
    'PROOF_DRIVER_METADATA_CHANGED',
    'PROOF_DRIVER_CLEANUP_UNVERIFIED',
    'PROOF_CANCELLED',
    'PROOF_EDIT_CLOCK_INVALID',
    'PROOF_EDIT_BUDGET_INSUFFICIENT',
  ]).has(reason)
    ? reason
    : 'PROOF_EVIDENCE_INVALID';
};
function boundDriver(directory, identity, originalLaunch, originalMetadata, retainLaunch) {
  privateDirectory(directory);
  const launched = privateJson(join(directory, 'launched.json'));
  assert.deepEqual(
    Object.keys(launched).sort(),
    ['birth', 'identity', ...(launched.editing ? ['editing'] : [])].sort(),
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  assertIdentity(launched.identity, identity);
  if (launched.editing) validateEditingMetadata(launched.editing);
  assert.deepEqual(
    Object.keys(launched.birth).sort(),
    ['boot', 'pid', 'start'],
    'PROOF_BIRTH_CHANGED',
  );
  assert.ok(
    Number.isSafeInteger(launched.birth.pid) &&
      launched.birth.pid > 0 &&
      /^[0-9]+$/.test(launched.birth.start) &&
      /^[a-f0-9-]{36}$/.test(launched.birth.boot),
    'PROOF_BIRTH_CHANGED',
  );
  if (originalLaunch) assert.deepEqual(launched, originalLaunch, 'PROOF_DRIVER_METADATA_CHANGED');
  // Retain only a fully validated launch birth before reading mutable peer metadata.
  retainLaunch?.(launched);
  const exists = existsSync(join(directory, 'driver.json'));
  assert.ok(exists || !originalMetadata, 'PROOF_DRIVER_METADATA_CHANGED');
  const expected = exists ? privateJson(join(directory, 'driver.json')) : undefined;
  if (expected) {
    assert.deepEqual(
      Object.keys(expected).sort(),
      [
        'schemaVersion',
        'identity',
        'birth',
        'socketDirectory',
        'phase',
        'continuations',
        'cancelled',
        'phaseTimings',
        ...(launched.editing ? ['editing', 'phaseB', 'firstFailure'] : []),
      ].sort(),
      'PROOF_DRIVER_METADATA_CHANGED',
    );
    assert.equal(typeof expected.socketDirectory, 'string', 'PROOF_DRIVER_METADATA_CHANGED');
    assertIdentity(expected.identity, identity);
    assert.deepEqual(expected.birth, launched.birth, 'PROOF_BIRTH_CHANGED');
    assert.equal(expected.schemaVersion, launched.editing ? 2 : 1, 'PROOF_DRIVER_METADATA_CHANGED');
    if (launched.editing) {
      assert.deepEqual(expected.editing, launched.editing, 'PROOF_DRIVER_METADATA_CHANGED');
      assert.equal(expected.phaseB, null, 'PROOF_DRIVER_METADATA_CHANGED');
      assert.equal(expected.firstFailure, null, 'PROOF_DRIVER_METADATA_CHANGED');
    }
    assert.equal(expected.phase, 'setup', 'PROOF_DRIVER_METADATA_CHANGED');
    assert.equal(expected.continuations, 0, 'PROOF_DRIVER_METADATA_CHANGED');
    assert.equal(expected.cancelled, false, 'PROOF_DRIVER_METADATA_CHANGED');
    assert.deepEqual(
      Object.keys(expected.phaseTimings).sort(),
      ['setupMs', 'pausedMs', 'recoveryMs'].sort(),
      'PROOF_DRIVER_METADATA_CHANGED',
    );
    assert.ok(
      Object.values(expected.phaseTimings).every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ),
      'PROOF_DRIVER_METADATA_CHANGED',
    );
    if (originalMetadata)
      assert.deepEqual(expected, originalMetadata, 'PROOF_DRIVER_METADATA_CHANGED');
  }
  return { launched, expected };
}
export function readEditingLaunch(directory, identity, anchor) {
  const { launched } = boundDriver(directory, identity);
  assert.ok(launched.editing, 'PROOF_DRIVER_METADATA_CHANGED');
  const step = readEditingStep(directory, identity, launched.editing.anchor, true);
  assert.deepEqual(launched.editing.phaseA, step.phaseA, 'PROOF_DRIVER_METADATA_CHANGED');
  assert.deepEqual(
    privateJson(join(directory, 'launch-claim.json')),
    step,
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  if (anchor) assert.deepEqual(launched.editing.anchor, anchor, 'PROOF_DRIVER_METADATA_CHANGED');
  assert.deepEqual(launched.birth, processBirth(), 'PROOF_BIRTH_CHANGED');
  return launched.editing;
}

// A cancelled driver can finish draining; it can never become natural success.
const cancellationFailure = (state) => {
  if (!state.cancelled) return null;
  const reason =
    state.schemaVersion === 2
      ? fixedProofFailure(new Error(state.firstFailure))
      : 'PROOF_CANCELLED';
  assert.ok(reason, 'PROOF_DRIVER_METADATA_CHANGED');
  return reason;
};
const phases = ['unobserved', 'setup', 'ready', 'recovery', 'settling', 'cancelled', 'complete'];
function retainedObservation(directory, identity, birth) {
  if (!existsSync(join(directory, 'observation.json'))) return;
  const row = privateJson(join(directory, 'observation.json'));
  assertIdentity(row.identity, identity);
  assert.deepEqual(row.birth, birth, 'PROOF_BIRTH_CHANGED');
  assert.ok(phases.includes(row.phase));
  assert.ok(Number.isSafeInteger(row.transientFailures) && row.transientFailures >= 0);
  assert.ok(Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0);
  for (const key of ['failure', 'lastTransient'])
    assert.ok(row[key] === undefined || safeFailure(new Error(row[key])) === row[key]);
  return row;
}
const rpcBudget = (deadline, code) => {
  const budget = Math.min(2500, remaining(deadline));
  assert.ok(budget > 0, code);
  return budget;
};
const remaining = (deadline) => Math.max(0, Math.floor(deadline - performance.now()));
const boundedSleep = (deadline) => sleep(Math.min(250, remaining(deadline)));
const phaseBudget = (budget, maximum) =>
  assert.ok(
    Number.isInteger(budget) && budget > 0 && budget <= maximum,
    'PROOF_PHASE_BUDGET_INVALID',
  );

/** Read-only observation retries do not redispatch any Live work. Every retry
 * rereads protected metadata and retains the originally launched exact birth. */
export async function observeRecoveryPhase(directory, predicate, budgetMs, identity, phaseBound) {
  phaseBudget(budgetMs, 1_800_000);
  const began = performance.now(),
    deadline = began + Math.min(budgetMs, phaseBound ? phaseBoundRemaining(phaseBound) : budgetMs);
  const diagnostic = { identity, phase: 'unobserved', transientFailures: 0, driverExited: false };
  let launch, metadata;
  try {
    while (remaining(deadline) > 0) {
      const bound = boundDriver(directory, identity, launch, metadata);
      launch ??= bound.launched;
      if (launch.editing) {
        const actual =
          phaseBound?.phase === 'action'
            ? continuationBound(directory, { ...launch, editing: launch.editing })
            : launch.editing.phaseA;
        assert.deepEqual(phaseBound, actual, 'PROOF_DRIVER_METADATA_CHANGED');
      }
      diagnostic.birth = launch.birth;
      assert.ok(birthCurrent(launch.birth), 'PROOF_DRIVER_EXITED');
      if (bound.expected) {
        metadata ??= bound.expected;
        try {
          const state = await handoffRequest(
            directory,
            'status',
            metadata,
            rpcBudget(deadline, 'PROOF_DRIVER_PHASE_DEADLINE'),
          );
          boundDriver(directory, identity, launch, metadata);
          assert.ok(birthCurrent(launch.birth), 'PROOF_DRIVER_EXITED');
          diagnostic.phase = state.phase;
          const cancelled = cancellationFailure(state);
          if (cancelled) throw new Error(cancelled);
          assert.ok(
            remaining(deadline) > 0 && (!phaseBound || phaseBoundRemaining(phaseBound) > 0),
            'PROOF_DRIVER_PHASE_DEADLINE',
          );
          if (predicate(state)) return state;
        } catch (error) {
          if (error.message !== 'PROOF_HANDOFF_UNAVAILABLE') throw error;
          boundDriver(directory, identity, launch, metadata);
          assert.ok(birthCurrent(launch.birth), 'PROOF_DRIVER_EXITED');
          diagnostic.transientFailures++;
          diagnostic.lastTransient = 'PROOF_HANDOFF_UNAVAILABLE';
        }
      }
      await boundedSleep(deadline);
    }
    throw new Error('PROOF_DRIVER_PHASE_DEADLINE');
  } catch (error) {
    diagnostic.failure = safeFailure(error);
    throw new Error(diagnostic.failure);
  } finally {
    diagnostic.elapsedMs = Math.round(performance.now() - began);
    if (launch) diagnostic.driverExited = !birthCurrent(launch.birth);
    writeJson(join(directory, 'observation.json'), diagnostic);
  }
}

/** Idempotent cancel may have arrived despite a lost response. Observe/drain
 * the same birth within one existing total budget; never retry continuation. */
export async function settleRecoveryDriver(
  directory,
  identity,
  budgetMs = 180_000,
  naturalCompletion = false,
) {
  phaseBudget(budgetMs, 180_000);
  const began = performance.now(),
    deadline = began + budgetMs;
  privateDirectory(directory);
  const cleanup = {
    identity,
    cancelSent: false,
    cancelAttempted: false,
    driverExited: false,
    phase: 'unobserved',
    transientFailures: 0,
  };
  let launch,
    metadata,
    observationChecked = false,
    metadataBlocked = false;
  const retainFailure = (error) => {
    cleanup.evidenceFailure ??= safeFailure(error);
    // Once protected metadata changes, issue no further command to the peer.
    metadataBlocked = true;
  };
  const retainCancellation = (state) => {
    const reason = cancellationFailure(state);
    if (reason) {
      assert.equal(cleanup.firstFailure ?? reason, reason, 'PROOF_DRIVER_METADATA_CHANGED');
      cleanup.firstFailure ??= reason;
      cleanup.cancellationObserved = true;
      cleanup.phase = state.phase;
    }
  };
  try {
    for (;;) {
      let bound;
      if (!metadataBlocked) {
        try {
          bound = boundDriver(directory, identity, launch, metadata, (value) => {
            if (!launch && birthCurrent(value.birth)) launch = value;
          });
          launch ??= bound.launched;
        } catch (error) {
          if (!launch) throw error; // No verified original birth can be observed safely.
          retainFailure(error);
        }
      }
      if (!observationChecked) {
        observationChecked = true;
        try {
          const observed = retainedObservation(directory, identity, launch.birth);
          if (observed?.phase === 'cancelled' && fixedProofFailure(new Error(observed.failure)))
            retainCancellation({
              schemaVersion: launch.editing ? 2 : 1,
              cancelled: true,
              phase: observed.phase,
              firstFailure: observed.failure,
            });
        } catch (error) {
          // Diagnostic observation cannot revoke otherwise verified control metadata.
          cleanup.evidenceFailure ??= safeFailure(error);
        }
      }
      cleanup.birth = launch.birth;
      cleanup.driverAliveAtCleanupStart ??= birthCurrent(launch.birth);
      if (!birthCurrent(launch.birth)) break;
      assert.ok(remaining(deadline) > 0, 'PROOF_DRIVER_CLEANUP_UNVERIFIED');
      if (
        !metadataBlocked &&
        bound.expected &&
        !cleanup.cancelSent &&
        !cleanup.cancellationObserved
      ) {
        metadata ??= bound.expected;
        try {
          if (naturalCompletion) {
            const state = await handoffRequest(
              directory,
              'status',
              metadata,
              rpcBudget(deadline, 'PROOF_DRIVER_CLEANUP_UNVERIFIED'),
            );
            retainCancellation(state);
            boundDriver(directory, identity, launch, metadata);
            if (cleanup.cancellationObserved || ['settling', 'complete'].includes(state.phase)) {
              cleanup.phase = state.phase;
              await boundedSleep(deadline);
              continue;
            }
          }
          cleanup.cancelAttempted = true;
          const state = await handoffRequest(
            directory,
            'cancel',
            metadata,
            rpcBudget(deadline, 'PROOF_DRIVER_CLEANUP_UNVERIFIED'),
          );
          if (naturalCompletion || launch.editing) retainCancellation(state);
          boundDriver(directory, identity, launch, metadata);
          cleanup.cancelSent = true;
          cleanup.phase = state.phase;
        } catch (error) {
          if (error.message === 'PROOF_HANDOFF_UNAVAILABLE') {
            try {
              boundDriver(directory, identity, launch, metadata);
            } catch (changed) {
              retainFailure(changed);
            }
            cleanup.transientFailures++;
            cleanup.lastTransient = 'PROOF_HANDOFF_UNAVAILABLE';
          } else retainFailure(error);
        }
      }
      await boundedSleep(deadline);
    }
    cleanup.driverExited = true;
    if (naturalCompletion) {
      const final = privateJson(join(directory, 'final-driver.json'));
      assert.equal(final.schemaVersion, launch.editing ? 2 : 1, 'PROOF_DRIVER_METADATA_CHANGED');
      if (cleanup.cancellationObserved)
        assert.equal(final.cancelled, true, 'PROOF_DRIVER_METADATA_CHANGED');
      assertIdentity(final.identity, identity);
      assert.deepEqual(final.birth, launch.birth);
      assert.equal(typeof final.cancelled, 'boolean', 'PROOF_DRIVER_METADATA_CHANGED');
      assert.equal(
        final.phase,
        final.cancelled ? 'cancelled' : 'complete',
        'PROOF_DRIVER_METADATA_CHANGED',
      );
      assert.equal(final.continuations, 1);
      if (launch.editing) {
        assert.deepEqual(final.editing, launch.editing, 'PROOF_DRIVER_METADATA_CHANGED');
        assert.deepEqual(
          final.phaseB,
          continuationBound(directory, launch),
          'PROOF_DRIVER_METADATA_CHANGED',
        );
        if (!final.cancelled)
          assert.equal(final.firstFailure, null, 'PROOF_DRIVER_METADATA_CHANGED');
      }
      retainCancellation(final);
      if (cleanup.cancellationObserved) {
        cleanup.failedButDrained = true;
        throw new Error(cleanup.firstFailure);
      }
      if (cleanup.evidenceFailure) throw new Error(cleanup.evidenceFailure);
      cleanup.finalDriverVerified = true;
    }
    if (cleanup.evidenceFailure) throw new Error(cleanup.evidenceFailure);
    return cleanup;
  } catch (error) {
    const failure = safeFailure(error);
    cleanup.failure = cleanup.firstFailure ?? cleanup.evidenceFailure ?? failure;
    if (failure !== cleanup.failure) cleanup.cleanupFailure = failure;
    throw new Error(cleanup.failure);
  } finally {
    cleanup.elapsedMs = Math.round(performance.now() - began);
    if (launch) cleanup.driverExited = !birthCurrent(launch.birth);
    if (
      !cleanup.driverExited ||
      (naturalCompletion && !cleanup.finalDriverVerified && !cleanup.failedButDrained)
    ) {
      cleanup.operationSettlementUnverified = true;
      cleanup.lockRetained = true;
    }
    // observation.json contains only fixed phase/codes and the exact launched
    // birth, never the socket path, environment or raw transport exception.
    try {
      const observed = retainedObservation(directory, identity, launch?.birth);
      if (observed) {
        if (observed.phase === 'cancelled' && fixedProofFailure(new Error(observed.failure))) {
          cleanup.firstFailure ??= observed.failure;
          if (cleanup.failure && cleanup.failure !== cleanup.firstFailure)
            cleanup.cleanupFailure ??= cleanup.failure;
          cleanup.failure = cleanup.firstFailure;
        }
        cleanup.setupObservation = {
          phase: observed.phase,
          transientFailures: observed.transientFailures,
          lastTransient: observed.lastTransient,
          failure: observed.failure,
          elapsedMs: observed.elapsedMs,
        };
      }
    } catch (error) {
      cleanup.failure ??= safeFailure(error);
    }
    writeJson(join(directory, 'cleanup.json'), cleanup);
    if (cleanup.failure) throw new Error(cleanup.failure);
  }
}
async function driver(command, directory) {
  const identity = candidateIdentity();
  const catalog = command.startsWith('catalog-');
  assert.equal(catalog, process.env.LIVE_PRODUCTION_COLD_CATALOG === '1');
  if (catalog) command = command.slice('catalog-'.length);
  const editing = command.startsWith('editing-');
  if (editing) command = command.slice('editing-'.length);
  const anchor =
    editing || catalog ? readEditingAnchor(process.env.LIVE_EDIT_JOB_ANCHOR) : undefined;
  if (editing && command === 'start') {
    requireEditingBudget(anchor, 'setup', 1);
    requireEditingBudget(anchor, 'cleanup', 2_460_000);
  }
  if (command === 'start') {
    const catalogSetupBudget = catalog ? catalogDriverBudget(anchor, 'setup') : undefined;
    if (catalog) assert.ok(catalogSetupBudget > 0, 'PROOF_DRIVER_PHASE_DEADLINE');
    privateDirectory(directory, !editing);
    const editingMetadata = editing ? claimEditingLaunch(directory, identity, anchor) : undefined;
    const child = spawn(process.execPath, ['scripts/live-production-entrypoint-proof.mjs'], {
      env: {
        ...process.env,
        LIVE_PRODUCTION_RECOVERY_CHANNEL: directory,
        ...(editing ? { LIVE_PRODUCTION_EDIT_CONTINUITY: '1' } : {}),
      },
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
    writeJson(join(directory, 'launched.json'), {
      identity,
      birth: processBirth(child.pid),
      ...(editing ? { editing: editingMetadata } : {}),
    });
    await observeRecoveryPhase(
      directory,
      (state) => state.phase === 'ready',
      editing
        ? Math.min(1_260_000, editingRemaining(anchor, 'accepted'))
        : catalog
          ? catalogSetupBudget
          : 1_800_000,
      identity,
      editingMetadata?.phaseA,
    );
  } else if (command === 'continue') {
    const catalogObservationBudget = catalog ? catalogDriverBudget(anchor, 'observe') : undefined;
    if (editing) requireEditingBudget(anchor, 'action', 1_020_000);
    const expected = privateJson(join(directory, 'driver.json'));
    assertIdentity(expected.identity, identity);
    const launched = privateJson(join(directory, 'launched.json'));
    assert.deepEqual(expected.birth, launched.birth, 'PROOF_BIRTH_CHANGED');
    if (editing) {
      const bound = boundDriver(directory, identity);
      assert.deepEqual(bound.launched.editing.anchor, anchor, 'PROOF_DRIVER_METADATA_CHANGED');
    }
    const phaseB = editing ? editingPhaseBound(anchor, 'action') : undefined;
    if (editing)
      writeFileSync(
        join(directory, 'continuation.json'),
        JSON.stringify({ identity, birth: expected.birth, phaseB }) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
    const catalogBound = catalog
      ? mintCatalogObservation(directory, identity, expected.birth, anchor)
      : undefined;
    const until =
      performance.now() +
      (editing
        ? phaseBoundRemaining(phaseB)
        : catalog
          ? Math.min(catalogObservationBudget, phaseBoundRemaining(catalogBound))
          : 1_800_000);
    await handoffRequest(directory, 'continue', expected, Math.min(2500, remaining(until)));
    if (catalog) {
      try {
        await observeRecoveryPhase(
          directory,
          (state) => ['settling', 'complete'].includes(state.phase),
          Math.max(1, remaining(until)),
          identity,
          catalogBound,
        );
      } catch (error) {
        if (error.message !== 'PROOF_DRIVER_EXITED') throw error;
        const final = privateJson(join(directory, 'final-driver.json'));
        assertIdentity(final.identity, identity);
        assert.deepEqual(final.birth, expected.birth);
        assert.equal(final.phase, 'complete');
        assert.equal(final.cancelled, false);
        assert.equal(final.continuations, 1);
      }
      readCatalogObservation(directory, identity, expected.birth, catalogBound);
      return;
    }
    if (editing) {
      try {
        await observeRecoveryPhase(
          directory,
          (state) => ['settling', 'complete'].includes(state.phase),
          Math.max(1, remaining(until)),
          identity,
          phaseB,
        );
      } catch (error) {
        if (error.message !== 'PROOF_DRIVER_EXITED') throw error;
        const final = privateJson(join(directory, 'final-driver.json'));
        assertIdentity(final.identity, identity);
        assert.deepEqual(final.birth, expected.birth);
        assert.equal(final.phase, 'complete');
        assert.equal(final.cancelled, false);
        assert.equal(final.continuations, 1);
        assert.deepEqual(final.editing, expected.editing, 'PROOF_DRIVER_METADATA_CHANGED');
        assert.deepEqual(final.phaseB, phaseB, 'PROOF_DRIVER_METADATA_CHANGED');
        assert.equal(final.firstFailure, null, 'PROOF_DRIVER_METADATA_CHANGED');
      }
      return;
    }
    while (birthCurrent(expected.birth) && remaining(until) > 0) {
      if (catalog) readCatalogObservation(directory, identity, expected.birth, catalogBound);
      await boundedSleep(until);
    }
    assert.equal(birthCurrent(expected.birth), false, 'PROOF_DRIVER_PHASE_DEADLINE');
    const final = privateJson(join(directory, 'final-driver.json'));
    assertIdentity(final.identity, identity);
    assert.deepEqual(final.birth, expected.birth);
    assert.equal(final.cancelled, false);
    assert.equal(final.phase, 'complete');
    assert.equal(final.continuations, 1);
  } else {
    assert.equal(command, 'cleanup');
    await settleRecoveryDriver(
      directory,
      identity,
      catalog
        ? catalogDriverBudget(anchor, 'cleanup')
        : editing
          ? Math.max(1, Math.min(180_000, editingRemaining(anchor, 'cleanup')))
          : 180_000,
      editing || catalog,
    );
  }
}
async function main() {
  const [command, argument, output] = process.argv.slice(2);
  if (['editing-clock', 'editing-setup-complete'].includes(command)) {
    const identity = candidateIdentity(),
      anchor = readEditingAnchor(process.env.LIVE_EDIT_JOB_ANCHOR);
    return command === 'editing-clock'
      ? mintEditingStep(resolve(argument), identity, anchor)
      : completeEditingSetup(resolve(argument), identity, anchor);
  }
  if (command === 'catalog-receipt') {
    const { validateColdCatalog } = await import('./live-production-cold-catalog.mjs');
    const receipt = validateColdCatalog(
      json(join(argument, 'production-entrypoint/production-entrypoint-proof.json')),
      candidateIdentity(),
    );
    const cleanup = json(join(argument, 'catalog-driver-cleanup.json'));
    assertIdentity(cleanup.identity, receipt.identity);
    assert.equal(cleanup.finalDriverVerified, true);
    assert.equal(cleanup.driverExited, true);
    for (const key of ['failure', 'operationSettlementUnverified', 'lockRetained'])
      assert.ok(!cleanup[key]);
    writeJson(join(argument, 'cold-catalog-diagnostic-receipt.json'), receipt);
    return;
  }
  if (
    [
      'catalog-start',
      'catalog-continue',
      'catalog-cleanup',
      'start',
      'continue',
      'cleanup',
      'editing-start',
      'editing-continue',
      'editing-cleanup',
    ].includes(command)
  )
    return driver(command, resolve(argument));
  if (command === 'receipt') {
    if (process.env.LIVE_PRODUCTION_PROOF_LANE === 'accept-steer')
      requireEditingBudget(readEditingAnchor(process.env.LIVE_EDIT_JOB_ANCHOR), 'artifacts', 1);
    return writeLaneReceipt(
      process.env.LIVE_PRODUCTION_PROOF_LANE,
      resolve(argument),
      candidateIdentity(),
      process.env.LIVE_PROOF_MODE ?? 'full',
      process.env.LIVE_PROOF_VERIFICATION_SCOPE || undefined,
      process.env.LIVE_PRODUCTION_SERIAL_PROFILE === '1',
    );
  }
  assert.ok(['aggregate', 'aggregate-diagnostic'].includes(command));
  const identity = candidateIdentity(),
    packets = {};
  try {
    for (const entry of readdirSync(argument, { withFileTypes: true })) {
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      const packet = loadLanePacket(join(argument, entry.name));
      assert.ok(!packets[packet.receipt.lane], 'PROOF_LANE_DUPLICATE');
      packets[packet.receipt.lane] = packet;
    }
    writeJson(
      output,
      command === 'aggregate'
        ? aggregateLanes(packets, identity)
        : aggregateDiagnostic(packets, identity),
    );
  } catch {
    writeJson(output, {
      schemaVersion: 1,
      passed: false,
      cleanupComplete: false,
      identity,
      failure: 'CONTROLLED_PROOF_EVIDENCE_INVALID',
      ...(command === 'aggregate-diagnostic'
        ? { diagnosticOnly: true, fullAcceptance: false }
        : {}),
      crossLaneEvidence: true,
    });
    throw new Error('CONTROLLED_PROOF_EVIDENCE_INVALID');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('CONTROLLED_PROOF_ORCHESTRATION_FAILED');
    process.exitCode = 1;
  });
}
