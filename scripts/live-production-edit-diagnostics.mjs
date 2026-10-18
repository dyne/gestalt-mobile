/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Controlled proof errors only. Never retain URLs, cookie values or bearer-shaped strings. */
export function safeBrowserFailure(message) {
  return String(message ?? '')
    .split('\n')[0]
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[url]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .slice(0, 500);
}

/** Runs in the preview; never return text, identifiers, URLs or arbitrary state. */
export function pickerChromeSnapshot() {
  const states = ['IDLE', 'PICKING', 'CONFIGURING', 'GENERATING', 'CYCLING', 'SAVING', 'EDITING'];
  const node = (element) => {
    if (!element) return { present: false };
    const style = getComputedStyle(element),
      rect = element.getBoundingClientRect();
    const size = (value) =>
      Number.isFinite(value) ? Math.max(0, Math.min(20000, Math.round(value))) : null;
    return {
      present: true,
      connected: element.isConnected === true,
      displayNone: style.display === 'none',
      visibilityHidden: ['hidden', 'collapse'].includes(style.visibility),
      opacityZero: style.opacity !== '' && Number(style.opacity) === 0,
      width: size(rect.width),
      height: size(rect.height),
      intersectsViewport:
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < innerWidth &&
        rect.top < innerHeight,
    };
  };
  try {
    const core = window.__IMPECCABLE_LIVE_CHROME_CORE__;
    const root = core?.root?.() ?? window.__IMPECCABLE_LIVE_UI_ROOT__ ?? document;
    const state = core?.debugState?.()?.state;
    return {
      available: true,
      helperState: states.includes(state) ? state : 'unknown',
      hideLiveBar:
        typeof window.__productionHelperHideLiveBar === 'boolean'
          ? window.__productionHelperHideLiveBar
          : null,
      globalBar: node(root.querySelector('#impeccable-live-global-bar')),
      pageChat: node(root.querySelector('#impeccable-live-page-chat')),
      pageChatInDocument: !!document.querySelector('#impeccable-live-page-chat'),
    };
  } catch {
    return { available: false };
  }
}

const boundaries = ['before-accept', 'after-accept', 'after-accept-ack', 'before-steer'];
export function boundedPickerObservation(value) {
  if (!value || !boundaries.includes(value.boundary)) return null;
  const boolean = (v) => (typeof v === 'boolean' ? v : null);
  const node = (v) =>
    Object.fromEntries([
      ...[
        'present',
        'connected',
        'displayNone',
        'visibilityHidden',
        'opacityZero',
        'intersectsViewport',
      ].map((k) => [k, boolean(v?.[k])]),
      ...['width', 'height'].map((k) => [
        k,
        Number.isInteger(v?.[k]) && v[k] >= 0 && v[k] <= 20000 ? v[k] : null,
      ]),
    ]);
  return {
    boundary: value.boundary,
    navigationCount:
      Number.isSafeInteger(value.navigationCount) &&
      value.navigationCount >= 0 &&
      value.navigationCount <= 100000
        ? value.navigationCount
        : null,
    available: boolean(value.available),
    helperState: [
      'IDLE',
      'PICKING',
      'CONFIGURING',
      'GENERATING',
      'CYCLING',
      'SAVING',
      'EDITING',
    ].includes(value.helperState)
      ? value.helperState
      : 'unknown',
    hideLiveBar: boolean(value.hideLiveBar),
    pageChatInDocument: boolean(value.pageChatInDocument),
    globalBar: node(value.globalBar),
    pageChat: node(value.pageChat),
  };
}

const operations = new Set([
  'admission-inspection',
  'admission-catalog-context',
  'admission-catalog-org',
  'admission-config',
  'admission-thread',
  'admission-account',
  'admission-resources',
  'policy-total',
  'policy-manager-verify',
  'policy-source-observer',
  'policy-agents-verify',
  'policy-local-installation',
  'controller-close',
  'signed-revoke',
  'poll-drain',
  'poll-settle',
  'helper-settle',
  'helper-remove-injection',
  'helper-forget-record',
  'owning-settle',
  'owning-abort',
  'project-stop',
]);
const failures = new Set([
  'LIVE_CLEANUP_REQUIRED',
  'LIVE_ADMISSION_UNAVAILABLE',
  'LIVE_INSTALLED_SOURCE_UNVERIFIED',
  'LIVE_RUNTIME_PROVENANCE_UNAVAILABLE',
  'LIVE_INSTALLATION_UNVERIFIED',
  'LIVE_GENERATION_STALE',
  'LIVE_STATE_CONFLICT',
  'LIVE_SETTLEMENT_REQUIRED',
  'LIVE_SETTLEMENT_UNAVAILABLE',
  'LIVE_HELPER_GENERATION_STALE',
  'LIVE_HELPER_RECOVERY_REQUIRED',
  'LIVE_HELPER_COMMAND_AMBIGUOUS',
  'LIVE_HELPER_COMMAND_UNAVAILABLE',
  'LIVE_PROJECT_PROCESS_UNAVAILABLE',
  'LIVE_NATIVE_SESSION_RECONCILIATION_REQUIRED',
  'LIVE_RELAY_OWNER_INVALID',
  'LIVE_RUNTIME_LIFETIME_UNVERIFIED',
  'LIVE_RELAY_AUTHORIZATION_CHANGED',
  'ERR_INVALID_STATE',
]);
const admissionReasons = new Set([
  'contract-refused',
  'command-unavailable',
  'configuration-changed',
  'source-changed',
  'stale-controller',
  'stale-election',
  'stale-runtime-provenance',
  'revoked-runtime-provenance',
  'stale-admission-receipt',
  'native-worker-active',
  'active-launch',
  'runtime-changed',
  'invalid-lifecycle-scope',
]);
const failureStages = new Set([
  'native-command-exit',
  'native-command-launch',
  'native-command-deadline',
  'native-command-oversized',
  'native-command-protocol',
  'native-command-cancelled',
  'helper-command-unverified',
]);
/** Observe exactly one original invocation. No retries, cancellation or changed result/error. */
export function observeProofMethod(
  target,
  key,
  operation,
  records,
  { before, after, role, when, limit = 64 } = {},
) {
  if (!operations.has(operation) || typeof target[key] !== 'function' || ![64, 512].includes(limit))
    throw new Error('PROOF_DIAGNOSTIC_METHOD_INVALID');
  const original = target[key];
  target[key] = function (...args) {
    if (when) {
      let selected = false;
      try {
        selected = when(this, args) === true;
      } catch {
        /* observation unavailable */
      }
      if (!selected) return original.apply(this, args);
    }
    const record = { operation, result: 'started', elapsedMs: 0 };
    if (records.length === limit) {
      records.shift();
      record.truncatedBefore = true;
    }
    records.push(record);
    try {
      const value = role?.(this);
      if (['helper', 'devserver'].includes(value)) record.role = value;
    } catch {
      /* diagnostic only */
    }
    const started = performance.now();
    try {
      before?.(this, record);
    } catch {
      record.snapshotUnavailable = true;
    }
    const finish = (error, failed = false) => {
      record.elapsedMs = Math.max(0, Math.min(3600000, Math.round(performance.now() - started)));
      record.result = failed ? 'failed' : 'completed';
      if (failed) {
        record.failure = 'UNCLASSIFIED';
        try {
          record.failure = failures.has(error?.message)
            ? error.message
            : failures.has(error?.code)
              ? error.code
              : 'UNCLASSIFIED';
          if (failureStages.has(error?.stage)) record.failureStage = error.stage;
          const diagnostic = error?.diagnostic ?? error?.cause?.diagnostic;
          if (admissionReasons.has(diagnostic?.reason)) record.admissionReason = diagnostic.reason;
        } catch {
          /* hostile errors remain unclassified; preserve the original rejection */
        }
      }
      try {
        after?.(this, record);
      } catch {
        record.snapshotUnavailable = true;
      }
    };
    try {
      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        result.then(
          () => {
            finish();
          },
          (error) => {
            finish(error, true);
          },
        );
        return result;
      }
      finish();
      return result;
    } catch (error) {
      finish(error, true);
      throw error;
    }
  };
}

/** Read only safe lifecycle/generation/closure facts; never release a lock. */
export function cleanupControllerSnapshot(controller) {
  try {
    const integer = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
    const states = ['starting', 'active', 'stopping', 'error', 'recoveryRequired', 'idle'];
    const phases = ['stop', 'resume', 'ready', 'route:ack', 'cleaned'];
    const children = (g) =>
      ['helper', 'devserver'].map((role) => {
        const proof = g[role]?.diagnostics?.();
        return {
          role,
          namespaceExited: proof?.namespaceExited === true,
          pipeDescriptorsClosed: proof?.pipeDescriptorsClosed === true,
        };
      });
    return {
      available: true,
      generations: [...controller.generations.values()].slice(0, 8).map((g) => {
        const run = g.run ? controller.owners.current(g.run.liveId) : undefined;
        return {
          state: states.includes(run?.state) ? run.state : 'unknown',
          phase: phases.includes(run?.phase) ? run.phase : 'other',
          generation: integer(run?.generation),
          plannedGeneration: integer(g.plannedGeneration),
          sameControllerEpoch:
            Number.isSafeInteger(run?.controllerEpoch) &&
            run.controllerEpoch === g.run?.controllerEpoch,
          sameRootThread:
            typeof run?.rootThreadId === 'string' && run.rootThreadId === g.session?.threadId,
          resumed: g.resumed === true,
          retired: g.retired === true,
          injected: g.injected === true,
          gatewayPresent: !!g.gateway,
          registrationPresent: !!g.registrationId,
          children: children(g),
        };
      }),
    };
  } catch {
    return { available: false };
  }
}

/** Existing read-only policy boundaries only. ALS correlates measurements; it
 * never carries readiness, cached observations or dispatch authority. */
export function observeInstalledPolicyTimings(prototype) {
  const labels = [
    'policy-total',
    'policy-manager-verify',
    'policy-source-observer',
    'policy-agents-verify',
    'policy-local-installation',
  ];
  const report = {
    timeBasis: 'milliseconds-since-diagnostic-installation',
    calls: [],
    counters: Object.fromEntries(
      labels.map((label) => [label, { started: 0, completed: 0, failed: 0, totalMs: 0 }]),
    ),
  };
  const scope = new AsyncLocalStorage();
  const began = performance.now();
  let groups = 0,
    sequence = 0;
  const options = (label, when) => ({
    limit: 512,
    when,
    before(_owner, record) {
      report.counters[label].started++;
      record.sequence = ++sequence;
      record.groupId = scope.getStore() ?? 0;
      record.startedAfterMs = Math.max(0, Math.round(performance.now() - began));
    },
    after(_owner, record) {
      report.counters[label][record.result]++;
      report.counters[label].totalMs += record.elapsedMs;
    },
  });
  const original = prototype.verify;
  if (typeof original !== 'function') throw new Error('PROOF_DIAGNOSTIC_METHOD_INVALID');
  const grouped = { invoke: original };
  observeProofMethod(grouped, 'invoke', 'policy-total', report.calls, options('policy-total'));
  prototype.verify = function (...args) {
    return scope.run(++groups, () => grouped.invoke.apply(this, args));
  };
  observeProofMethod(
    prototype,
    'command',
    'policy-manager-verify',
    report.calls,
    options(
      'policy-manager-verify',
      (owner, [binary, args]) =>
        binary === owner.installation.manager.path &&
        Array.isArray(args) &&
        args.length === 4 &&
        args[0] === 'live-policy' &&
        args[1] === 'verify' &&
        args[2] === '--manifest',
    ),
  );
  observeProofMethod(
    prototype,
    'command',
    'policy-agents-verify',
    report.calls,
    options(
      'policy-agents-verify',
      (owner, [binary, args]) =>
        binary === owner.installation.node.path &&
        Array.isArray(args) &&
        args.length === 4 &&
        args[1] === 'verify' &&
        args[2] === '--bootstrap' &&
        owner.installation.packages.some(
          (entry) =>
            entry.name === 'gestalt' && args[0] === entry.root + '/scripts/live-admission.mjs',
        ),
    ),
  );
  observeProofMethod(
    prototype,
    'observeOriginalSources',
    'policy-source-observer',
    report.calls,
    options('policy-source-observer'),
  );
  observeProofMethod(
    prototype,
    'verifyInstallation',
    'policy-local-installation',
    report.calls,
    options('policy-local-installation'),
  );
  return report;
}

/** Proof-only RPC spans. Groups identify an inspection, never cached authority.
 * Resource checks outside inspection use group zero; nested spans are nonadditive. */
export function observeAdmissionTimings(runtimePrototype, controllerPrototype) {
  const labels = [
    'admission-inspection',
    'admission-catalog-context',
    'admission-catalog-org',
    'admission-config',
    'admission-thread',
    'admission-account',
    'admission-resources',
  ];
  const report = {
    timeBasis: 'milliseconds-since-diagnostic-installation',
    calls: [],
    counters: Object.fromEntries(
      labels.map((label) => [label, { started: 0, completed: 0, failed: 0, totalMs: 0 }]),
    ),
  };
  const scope = new AsyncLocalStorage();
  const began = performance.now();
  let groups = 0,
    sequence = 0;
  const options = (label, when) => ({
    limit: 512,
    when,
    before(_owner, record) {
      report.counters[label].started++;
      record.sequence = ++sequence;
      record.groupId = scope.getStore() ?? 0;
      record.startedAfterMs = Math.max(0, Math.round(performance.now() - began));
    },
    after(_owner, record) {
      report.counters[label][record.result]++;
      report.counters[label].totalMs += record.elapsedMs;
    },
  });
  const original = runtimePrototype.inspectLiveAdmission;
  if (typeof original !== 'function') throw new Error('PROOF_DIAGNOSTIC_METHOD_INVALID');
  const grouped = { invoke: original };
  observeProofMethod(
    grouped,
    'invoke',
    'admission-inspection',
    report.calls,
    options('admission-inspection'),
  );
  runtimePrototype.inspectLiveAdmission = function (...args) {
    return scope.run(++groups, () => grouped.invoke.apply(this, args));
  };
  observeProofMethod(
    controllerPrototype,
    'verifyProjectResources',
    'admission-resources',
    report.calls,
    options('admission-resources'),
  );
  return {
    report,
    observeRpc(rpc) {
      for (const [label, selected] of [
        [
          'admission-catalog-context',
          ([method, params]) =>
            method === 'mcpServerStatus/list' &&
            params?.serverName === 'context-mode' &&
            typeof params.threadId === 'string' &&
            params.threadId.length > 0 &&
            params.detail === 'full',
        ],
        [
          'admission-catalog-org',
          ([method, params]) =>
            method === 'mcpServerStatus/list' &&
            params?.serverName === 'gestalt-org-plan' &&
            typeof params.threadId === 'string' &&
            params.threadId.length > 0 &&
            params.detail === 'full',
        ],
        [
          'admission-config',
          ([method, params]) => method === 'config/read' && params?.includeLayers === true,
        ],
        [
          'admission-thread',
          ([method, params]) => method === 'thread/read' && params?.includeTurns === false,
        ],
        [
          'admission-account',
          ([method, params]) => method === 'account/read' && params?.refreshToken === false,
        ],
      ])
        observeProofMethod(
          rpc,
          'request',
          label,
          report.calls,
          options(label, (_owner, args) => selected(args)),
        );
    },
  };
}
