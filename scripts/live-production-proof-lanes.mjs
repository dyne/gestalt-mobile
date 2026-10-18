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
import { proofMode, validateSmokeEvidence } from './live-picker-smoke.mjs';

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
const modelChecks = [
  'actualMobileUiStartWithProductionAuthentication',
  'chatAutopilotOrgWritersRefusedDuringPickerFlow',
  'previewProbeHandedToActualBrowserConnection',
  'helperBearerAbsentFromActualProviderWire',
  'actualContextMcpCompletedBeforeArtifactValidation',
  'actualMobileUiOpenAuthenticatedRemoteOverlay',
  'actualModelToolsAndChildInheritedConfinement',
  'nativeModelContextToolConfined',
  'futureControlDenialsAndArtifactCarveouts',
  'sameOwningThreadModelThinkingAndDurableInbox',
];
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
    ...modelChecks,
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
  realPickerGenerateSteerManualApplyAcceptDiscard: ['accept-steer', 'manual-discard'],
  canonicalJournalSourceEffectsAndDiscardRestoration: ['manual-discard'],
  actualViteHmrThroughAuthenticatedGateway: ['accept-steer'],
  actualBackgroundBeyondEightSecondsPreservesFencing: ['accept-steer'],
  originalSurvivorReplacementLineageInOneLivingFixture: ['recovery'],
});
export function selectedLanes(selection) {
  const mode = proofMode(selection);
  const editing = (selection.message ?? '').includes('[editing-lanes]');
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
export function validateProductionLane(lane, report, identity) {
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
      assert.equal(browser.realPickerGenerateAccept, true);
      assert.equal(browser.realPickerSteer, true);
      for (const key of ['freshDocumentHelperConnected', 'visibleChrome', 'acceptedHeading'])
        assert.equal(browser.acceptContinuity[key], true);
      assert.ok(
        Number.isSafeInteger(browser.acceptContinuity.elapsedMs) &&
          browser.acceptContinuity.elapsedMs >= 0 &&
          browser.acceptContinuity.elapsedMs < 300_000,
      );
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
        ...(lane === 'recovery' ? ['recovery-driver-cleanup.json'] : []),
      ];
function validateDriverCleanup(report, identity) {
  assertIdentity(report.identity, identity);
  assert.equal(report.driverExited, true);
  assert.equal(report.cancelSent, false);
  assert.notEqual(report.cancelAttempted, true);
  assert.equal(report.failure, undefined);
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
  const files = laneFiles(lane);
  const reports = Object.fromEntries(files.map((file) => [file, json(join(directory, file))]));
  if (lane === 'independent') validateIndependent(reports, identity);
  else if (lane === 'picker-diagnostic') validateDiagnosticPicker(reports[files[0]], identity);
  else {
    validateProductionLane(lane, reports[files[0]], identity);
    if (lane === 'recovery')
      validateDriverCleanup(reports['recovery-driver-cleanup.json'], identity);
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
  for (const lane of fullLanes) {
    const { receipt, reports } = packets[lane];
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.lane, lane);
    assert.equal(receipt.mode, undefined);
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
    if (lane === 'independent') validateIndependent(parsed, identity);
    else {
      validateProductionLane(lane, parsed[files[0]], identity);
      if (lane === 'recovery')
        validateDriverCleanup(parsed['recovery-driver-cleanup.json'], identity);
    }
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
}) {
  assert.ok(
    Number.isFinite(pauseMs) && pauseMs > 0 && pauseMs <= 1_800_000,
    'PROOF_PHASE_BUDGET_INVALID',
  );
  privateDirectory(directory);
  privateDirectory(socketDirectory);
  const birth = processBirth();
  const began = performance.now();
  let readyAt, continuedAt;
  let phase = 'setup',
    continuations = 0,
    cancelled = false,
    resume,
    rejectPause;
  let cancellation;
  const snapshot = () => ({
    schemaVersion: 1,
    identity,
    birth,
    socketDirectory,
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
  const cancel = () => {
    if (!cancelled) {
      cancelled = true;
      phase = 'cancelled';
      rejectPause?.(new Error('PROOF_CANCELLED'));
      cancellation = Promise.resolve().then(onCancel);
      cancellation.catch(() => {});
    }
    return cancellation;
  };
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
        assert.deepEqual(Object.keys(request).sort(), ['birth', 'command', 'identity']);
        assertIdentity(request.identity, identity);
        assert.deepEqual(request.birth, birth);
        assert.ok(birthCurrent(birth));
        if (request.command === 'continue') {
          assert.ok(phase === 'ready' && continuations === 0 && !cancelled);
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
    assertCurrent() {
      assert.ok(!cancelled && birthCurrent(birth), 'PROOF_CANCELLED');
    },
    async boundary() {
      assert.ok(phase === 'setup' && !cancelled, 'PROOF_HANDOFF_PHASE_INVALID');
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
    },
    async close() {
      if (phase === 'ready') await cancel();
      await cancellation;
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
    socket.on('connect', () =>
      socket.end(
        JSON.stringify({ command, identity: expected.identity, birth: expected.birth }) + '\n',
      ),
    );
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
          ].sort(),
        );
        assert.equal(response.schemaVersion, 1);
        assert.equal(response.socketDirectory, expected.socketDirectory ?? directory);
        assert.ok(['setup', 'ready', 'recovery', 'cancelled', 'complete'].includes(response.phase));
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
  ]).has(reason)
    ? reason
    : 'PROOF_EVIDENCE_INVALID';
};
function boundDriver(directory, identity, originalLaunch, originalMetadata) {
  privateDirectory(directory);
  const launched = privateJson(join(directory, 'launched.json'));
  assert.deepEqual(
    Object.keys(launched).sort(),
    ['birth', 'identity'],
    'PROOF_DRIVER_METADATA_CHANGED',
  );
  assertIdentity(launched.identity, identity);
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
      ].sort(),
      'PROOF_DRIVER_METADATA_CHANGED',
    );
    assert.equal(typeof expected.socketDirectory, 'string', 'PROOF_DRIVER_METADATA_CHANGED');
    assertIdentity(expected.identity, identity);
    assert.deepEqual(expected.birth, launched.birth, 'PROOF_BIRTH_CHANGED');
    assert.equal(expected.schemaVersion, 1, 'PROOF_DRIVER_METADATA_CHANGED');
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
const phases = ['unobserved', 'setup', 'ready', 'recovery', 'cancelled', 'complete'];
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
export async function observeRecoveryPhase(directory, predicate, budgetMs, identity) {
  phaseBudget(budgetMs, 1_800_000);
  const began = performance.now(),
    deadline = began + budgetMs;
  const diagnostic = { identity, phase: 'unobserved', transientFailures: 0, driverExited: false };
  let launch, metadata;
  try {
    while (remaining(deadline) > 0) {
      const bound = boundDriver(directory, identity, launch, metadata);
      launch ??= bound.launched;
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
export async function settleRecoveryDriver(directory, identity, budgetMs = 180_000) {
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
  let launch, metadata;
  try {
    for (;;) {
      const bound = boundDriver(directory, identity, launch, metadata);
      launch ??= bound.launched;
      cleanup.birth = launch.birth;
      cleanup.driverAliveAtCleanupStart ??= birthCurrent(launch.birth);
      if (!birthCurrent(launch.birth)) break;
      assert.ok(remaining(deadline) > 0, 'PROOF_DRIVER_CLEANUP_UNVERIFIED');
      if (bound.expected && !cleanup.cancelSent) {
        metadata ??= bound.expected;
        cleanup.cancelAttempted = true;
        try {
          const state = await handoffRequest(
            directory,
            'cancel',
            metadata,
            rpcBudget(deadline, 'PROOF_DRIVER_CLEANUP_UNVERIFIED'),
          );
          boundDriver(directory, identity, launch, metadata);
          cleanup.cancelSent = true;
          cleanup.phase = state.phase;
        } catch (error) {
          if (error.message !== 'PROOF_HANDOFF_UNAVAILABLE') throw error;
          boundDriver(directory, identity, launch, metadata);
          cleanup.transientFailures++;
          cleanup.lastTransient = 'PROOF_HANDOFF_UNAVAILABLE';
        }
      }
      await boundedSleep(deadline);
    }
    cleanup.driverExited = true;
    return cleanup;
  } catch (error) {
    cleanup.failure = safeFailure(error);
    throw new Error(cleanup.failure);
  } finally {
    cleanup.elapsedMs = Math.round(performance.now() - began);
    if (launch) cleanup.driverExited = !birthCurrent(launch.birth);
    // observation.json contains only fixed phase/codes and the exact launched
    // birth, never the socket path, environment or raw transport exception.
    try {
      if (existsSync(join(directory, 'observation.json'))) {
        const observed = privateJson(join(directory, 'observation.json'));
        assertIdentity(observed.identity, identity);
        assert.deepEqual(observed.birth, launch?.birth, 'PROOF_BIRTH_CHANGED');
        assert.ok(phases.includes(observed.phase));
        assert.ok(
          Number.isSafeInteger(observed.transientFailures) && observed.transientFailures >= 0,
        );
        assert.ok(Number.isSafeInteger(observed.elapsedMs) && observed.elapsedMs >= 0);
        for (const key of ['failure', 'lastTransient'])
          assert.ok(
            observed[key] === undefined || safeFailure(new Error(observed[key])) === observed[key],
          );
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
  if (command === 'start') {
    privateDirectory(directory, true);
    const child = spawn(process.execPath, ['scripts/live-production-entrypoint-proof.mjs'], {
      env: { ...process.env, LIVE_PRODUCTION_RECOVERY_CHANNEL: directory },
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
    writeJson(join(directory, 'launched.json'), { identity, birth: processBirth(child.pid) });
    await observeRecoveryPhase(directory, (state) => state.phase === 'ready', 1_800_000, identity);
  } else if (command === 'continue') {
    const expected = privateJson(join(directory, 'driver.json'));
    assertIdentity(expected.identity, identity);
    const launched = privateJson(join(directory, 'launched.json'));
    assert.deepEqual(expected.birth, launched.birth, 'PROOF_BIRTH_CHANGED');
    const until = performance.now() + 1_800_000;
    await handoffRequest(directory, 'continue', expected, Math.min(2500, remaining(until)));
    while (birthCurrent(expected.birth) && remaining(until) > 0) await boundedSleep(until);
    assert.equal(birthCurrent(expected.birth), false, 'PROOF_DRIVER_PHASE_DEADLINE');
    const final = privateJson(join(directory, 'final-driver.json'));
    assertIdentity(final.identity, identity);
    assert.deepEqual(final.birth, expected.birth);
    assert.equal(final.cancelled, false);
    assert.equal(final.phase, 'complete');
    assert.equal(final.continuations, 1);
  } else {
    assert.equal(command, 'cleanup');
    await settleRecoveryDriver(directory, identity);
  }
}
async function main() {
  const [command, argument, output] = process.argv.slice(2);
  if (['start', 'continue', 'cleanup'].includes(command)) return driver(command, resolve(argument));
  if (command === 'receipt')
    return writeLaneReceipt(
      process.env.LIVE_PRODUCTION_PROOF_LANE,
      resolve(argument),
      candidateIdentity(),
      process.env.LIVE_PROOF_MODE ?? 'full',
      process.env.LIVE_PROOF_VERIFICATION_SCOPE || undefined,
    );
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
