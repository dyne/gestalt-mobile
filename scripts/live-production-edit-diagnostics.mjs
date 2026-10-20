/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

// Explicit test allocation, not a product lease or authority. All offsets are
// relative to one runner monotonic anchor; a continuation cannot reset them.
export const editingSchedule = Object.freeze({
  setup: 120_000,
  accepted: 1_380_000,
  action: 2_400_000,
  cleanup: 2_580_000,
  artifacts: 2_640_000,
  job: 2_700_000,
  resume: 720_000,
  reopenedBrowser: 300_000,
});
export function editingRemaining(anchor, phase, now = process.hrtime.bigint()) {
  if (
    !anchor ||
    !/^[0-9]{1,24}$/.test(anchor.monotonicNs ?? '') ||
    !['setup', 'accepted', 'action', 'cleanup', 'artifacts', 'job'].includes(phase) ||
    now < BigInt(anchor.monotonicNs)
  )
    throw new Error('PROOF_EDIT_CLOCK_INVALID');
  return Math.max(
    0,
    Math.floor(editingSchedule[phase] - Number(now - BigInt(anchor.monotonicNs)) / 1e6),
  );
}
export function requireEditingBudget(anchor, phase, minimum, now) {
  const left = editingRemaining(anchor, phase, now);
  if (!Number.isSafeInteger(minimum) || minimum <= 0 || left < minimum)
    throw new Error('PROOF_EDIT_BUDGET_INSUFFICIENT');
  return left;
}
export async function drainEditingFailure({ pending, record, stop }) {
  record({ operationPending: !!pending, cleanupPending: true, lockRetained: true });
  await pending?.catch(() => {});
  return stop();
}
export function editingLeaseCapacity(status, generation, now = Date.now()) {
  return (
    Number.isSafeInteger(generation) &&
    generation > 0 &&
    status?.generation === generation &&
    Math.min(Date.parse(status.leaseExpiresAt), Date.parse(status.absoluteExpiresAt)) - now >=
      195_000
  );
}
/** One observation of the actual cookie's lease, immediately before UI dispatch.
 * Neither a peer's valid lease nor a hoped-for future renewal supplies capacity. */
export async function observeEditingSteer({
  observeContinuity,
  readLease,
  submit,
  generation,
  hostDeadline,
  now = Date.now,
}) {
  await observeContinuity();
  const lease = await readLease();
  const sampledAt = now();
  if (!editingLeaseCapacity(lease, generation, sampledAt))
    throw new Error('PROOF_EDIT_LEASE_INSUFFICIENT');
  const deadline =
    Math.min(hostDeadline, Date.parse(lease.leaseExpiresAt), Date.parse(lease.absoluteExpiresAt)) -
    15_000;
  if (deadline - sampledAt < 180_000) throw new Error('PROOF_EDIT_BUDGET_INSUFFICIENT');
  return submit(deadline);
}
export function assertOldPreviewCookieDenied(response) {
  let code;
  try {
    code = JSON.parse(response?.body).code;
  } catch {
    /* Fixed refusal below. */
  }
  if (response?.status !== 401 || code !== 'LIVE_AUTH_REQUIRED')
    throw new Error('PROOF_OLD_COOKIE_NOT_DENIED');
}

/** Observe one real grant/exchange under one fixed deadline. The exchange's
 * navigation response body is deliberately never consumed: Chromium may retire
 * its document before body delivery. Identity comes from the stable opener's
 * authenticated grant request and the exact exchange request instead. */
export async function observePreviewExchange({
  grantResponse,
  exchangeResponse,
  liveId,
  generation,
  previewOrigin,
  deadline,
  checkpoint,
}) {
  const requireIdentity = (condition) => {
    if (!condition) throw new Error('PROOF_PREVIEW_IDENTITY_INVALID');
  };
  checkpoint('preview-grant-response');
  const granted = await withinProofObservation(() => grantResponse, deadline);
  const request = granted.request();
  const body = request.postDataJSON();
  requireIdentity(
    request.method() === 'POST' &&
      granted.status() === 201 &&
      body.liveId === liveId &&
      body.generation === generation &&
      body.codeChallengeMethod === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(body.codeChallenge ?? ''),
  );
  checkpoint('preview-grant-body');
  const grant = await withinProofObservation(() => granted.json(), deadline);
  requireIdentity(grant.previewOrigin === previewOrigin);
  checkpoint('preview-exchange-response');
  const exchanged = await withinProofObservation(() => exchangeResponse, deadline);
  const exchange = exchanged.request();
  const data = exchange.postDataJSON();
  const url = new URL(exchanged.url());
  requireIdentity(
    exchange.method() === 'POST' &&
      exchanged.status() === 201 &&
      url.origin === previewOrigin &&
      url.pathname === '/__gestalt_live/exchange' &&
      typeof grant.grantId === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(grant.grantId) &&
      /^[A-Za-z0-9_-]{43,128}$/.test(grant.grant ?? '') &&
      data.grantId === grant.grantId &&
      data.grant === grant.grant &&
      /^[A-Za-z0-9_-]{43,128}$/.test(data.codeVerifier ?? '') &&
      createHash('sha256').update(data.codeVerifier).digest('base64url') === body.codeChallenge,
  );
  return { liveId, generation };
}

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
const proofAuthorityContext = new AsyncLocalStorage();
const closureBoundaries = new Set(['open', 'closing', 'closed', 'close-failed']);
const proofFailure = (error) => {
  try {
    return failures.has(error?.message)
      ? error.message
      : failures.has(error?.code)
        ? error.code
        : 'UNCLASSIFIED';
  } catch {
    return 'UNCLASSIFIED';
  }
};
/** Fixed observation only: does not cancel, retry, authorize or reinterpret errors. */
export function observeEventAuthority(target, records, closureBoundary) {
  const original = target.liveEvent;
  if (typeof original !== 'function') throw new Error('PROOF_DIAGNOSTIC_METHOD_INVALID');
  const boundary = () => {
    try {
      const value = closureBoundary();
      return closureBoundaries.has(value) ? value : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };
  target.liveEvent = async function (fence, eventId, work) {
    const began = performance.now();
    const row = {
      phase: /^[a-f0-9]{8}$/.test(eventId) ? 'event-turn' : 'canonical-poll',
      grantedAfterMs: null,
      elapsedMs: 0,
      completed: false,
      closureAtStart: boundary(),
    };
    try {
      const result = await original.call(this, fence, eventId, async () => {
        row.grantedAfterMs = Math.round(performance.now() - began);
        const observation = { guard: this, fence, phase: row.phase, active: true };
        return proofAuthorityContext.run(observation, async () => {
          try {
            return await work();
          } finally {
            observation.active = false;
          }
        });
      });
      row.completed = true;
      return result;
    } catch (error) {
      row.failure = proofFailure(error);
      throw error;
    } finally {
      row.elapsedMs = Math.round(performance.now() - began);
      row.closureAtFinish = boundary();
      if (records.length === 64) records.shift();
      records.push(row);
    }
  };
}
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

/** One original deadline; callers must never create a new one after navigation. */
export function proofObservationRemaining(deadline, now = Date.now()) {
  const remaining = Math.floor(deadline - now);
  if (!Number.isFinite(deadline) || remaining <= 0 || remaining > 300_000)
    throw new Error('PROOF_OBSERVATION_DEADLINE');
  return remaining;
}
export async function withinProofObservation(work, deadline, now = Date.now) {
  const remaining = proofObservationRemaining(deadline, now());
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('PROOF_OBSERVATION_DEADLINE')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Executes only in the actual current preview document. Never supplies UI/SSE state. */
export function pickerContinuityProbe({ heading, documentBirth = null }) {
  const birth = performance.timeOrigin;
  if (!Number.isFinite(birth) || birth <= 0 || (documentBirth !== null && birth !== documentBirth))
    return false;
  if (
    document.readyState === 'loading' ||
    window.__productionHelperConnected !== true ||
    window.__productionHelperConnectedDocument !== birth
  )
    return false;
  const core = window.__IMPECCABLE_LIVE_CHROME_CORE__;
  const root = core?.root?.() ?? window.__IMPECCABLE_LIVE_UI_ROOT__ ?? document;
  const visible = (node) => {
    if (!node?.isConnected) return false;
    const style = getComputedStyle(node),
      rect = node.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      !['hidden', 'collapse'].includes(style.visibility) &&
      style.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const title = document.querySelector('h1.hero-title');
  if (
    title?.textContent !== heading ||
    !visible(title) ||
    !visible(root.querySelector('#impeccable-live-global-bar')) ||
    !visible(root.querySelector('#impeccable-live-page-chat'))
  )
    return false;
  return { documentBirth: birth };
}
export async function observePickerContinuity(page, { deadline, heading, now = Date.now }) {
  const started = now();
  for (;;) {
    const handle = await withinProofObservation(
      () =>
        page.waitForFunction(
          pickerContinuityProbe,
          { heading },
          { polling: 100, timeout: proofObservationRemaining(deadline, now()) },
        ),
      deadline,
      now,
    );
    let observed;
    try {
      observed = await withinProofObservation(() => handle.jsonValue(), deadline, now);
      const current = await withinProofObservation(
        () =>
          page.evaluate(pickerContinuityProbe, { heading, documentBirth: observed.documentBirth }),
        deadline,
        now,
      );
      if (current && current.documentBirth === observed.documentBirth) {
        proofObservationRemaining(deadline, now());
        return {
          freshDocumentHelperConnected: true,
          visibleChrome: true,
          acceptedHeading: true,
          elapsedMs: Math.max(0, Math.round(now() - started)),
        };
      }
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(error?.message ?? ''))
        throw error;
      // Navigation invalidates observations; retry reads under the SAME deadline.
    } finally {
      await handle.dispose?.();
    }
  }
}

/** Observe the existing IPC dispatch; never sends commands or claims foreground child birth. */
export function observeCanonicalPollDispatch(prototype, assertBirthCurrent) {
  const calls = new Map();
  let sequence = 0;
  const originalCommand = prototype.helperCommand,
    originalSend = prototype.send;
  if (typeof originalCommand !== 'function' || typeof originalSend !== 'function')
    throw new Error('PROOF_POLL_DISPATCH_SEAM_UNAVAILABLE');
  prototype.helperCommand = function (receipt, args, ...rest) {
    const authority = proofAuthorityContext.getStore();
    if (
      args?.length !== 2 ||
      args[0] !== 'live-poll' ||
      args[1] !== '--timeout=600000' ||
      authority?.phase !== 'canonical-poll' ||
      !authority.active
    )
      return originalCommand.call(this, receipt, args, ...rest);
    const state = { receipt, authority, settled: false, sequence: ++sequence };
    calls.set(this, state);
    try {
      const result = originalCommand.call(this, receipt, args, ...rest);
      result.then(
        () => {
          state.settled = true;
        },
        () => {
          state.settled = true;
        },
      );
      return result;
    } catch (error) {
      state.settled = true;
      throw error;
    }
  };
  prototype.send = function (message) {
    const result = originalSend.call(this, message);
    const state = calls.get(this);
    if (
      state &&
      !state.settled &&
      message?.op === 'helper-command' &&
      message.args?.length === 2 &&
      message.args[0] === 'live-poll' &&
      message.args[1] === '--timeout=600000'
    ) {
      state.requestId = message.requestId;
      state.request = this.commands?.get(message.requestId);
      state.sent = true;
    }
    return result;
  };
  return (sessionId, generation) => {
    for (const [process, state] of calls) {
      const { receipt, authority } = state;
      if (
        receipt.role !== 'helper' ||
        receipt.sessionId !== sessionId ||
        receipt.generation !== generation
      )
        continue;
      try {
        if (
          !state.sent ||
          !state.request ||
          state.settled ||
          !authority.active ||
          process.revoked ||
          process.commands?.get(state.requestId) !== state.request
        )
          continue;
        const run = authority.guard.input.owners.assert(authority.fence);
        if (
          run.state !== 'active' ||
          run.relayId !== sessionId ||
          run.generation !== generation ||
          JSON.stringify(process.receipt) !== JSON.stringify(receipt)
        )
          continue;
        for (const birth of [receipt.owner, receipt.relay, receipt.target])
          if (assertBirthCurrent(birth) === false) throw new Error('PROOF_POLL_BIRTH_CHANGED');
        // Fence again after observing births; none of these observations grants authority.
        if (
          state.settled ||
          !authority.active ||
          process.commands.get(state.requestId) !== state.request ||
          process.revoked
        )
          continue;
        const current = authority.guard.input.owners.assert(authority.fence);
        if (
          current.state !== 'active' ||
          current.generation !== generation ||
          current.relayId !== sessionId
        )
          continue;
        return {
          sequence: state.sequence,
          commandIpcDispatched: true,
          workerBirthsCurrent: true,
          foregroundChildBirthObserved: false,
          postAuthority: true,
          pending: true,
          generationMatches: true,
        };
      } catch {
        /* A refused or retired observation never releases the test driver. */
      }
    }
    return null;
  };
}
/** Read the existing owning flight only. Neither this observer nor its clock
 * creates a helper poll or releases the browser before positive IPC evidence. */
export async function observePostAcceptPollDispatch({
  sample,
  deadline,
  now = Date.now,
  pause = () => new Promise((resolve) => setTimeout(resolve, 25)),
}) {
  for (;;) {
    proofObservationRemaining(deadline, now());
    const current = sample();
    proofObservationRemaining(deadline, now());
    if (current) {
      if (
        !Number.isSafeInteger(current.sequence) ||
        current.sequence <= 0 ||
        current.commandIpcDispatched !== true ||
        current.workerBirthsCurrent !== true ||
        current.postAuthority !== true ||
        current.pending !== true ||
        current.generationMatches !== true ||
        current.foregroundChildBirthObserved !== false
      )
        throw new Error('PROOF_POST_ACCEPT_POLL_INVALID');
      return current;
    }
    await withinProofObservation(pause, deadline, now);
  }
}
export function manualObservationDeadline({ startedAt, hostDeadline, now = Date.now() }) {
  // Pre-enqueue observation only. The event's actual595s inbox lease starts at receipt.
  // Reserve150s manual +120s Generate +120s Discard +60s UI +30s cleanup.
  const reserve = 480_000;
  const deadline = Math.min(
    startedAt + 300_000,
    hostDeadline - reserve,
    startedAt + 595_000 - reserve,
  );
  proofObservationRemaining(deadline, now);
  return deadline;
}
export function verifyManualAcknowledgement({
  requestStartedAt,
  acceptedAt,
  acknowledgedAt,
  entryDigest,
  correlation,
  canonical,
}) {
  const check = (value) => {
    if (!value) throw new Error('PROOF_MANUAL_ACK_INVALID');
  };
  check([requestStartedAt, acceptedAt, acknowledgedAt].every(Number.isSafeInteger));
  check(requestStartedAt <= acceptedAt && acceptedAt <= acknowledgedAt);
  check(/^[a-f0-9]{64}$/.test(entryDigest ?? '') && correlation?.entryDigest === entryDigest);
  check(
    correlation.eventDigest === canonical?.eventDigest &&
      /^[a-f0-9]{64}$/.test(canonical.eventDigest),
  );
  check(
    canonical.kind === 'manual_edit_apply' &&
      canonical.stage === 'acknowledged' &&
      JSON.stringify(canonical.history) ===
        JSON.stringify(['received', 'dispatched', 'applied', 'acknowledged']),
  );
  check(Number.isSafeInteger(canonical.leaseUntil) && acknowledgedAt < canonical.leaseUntil);
  const upperBoundMs = acknowledgedAt - requestStartedAt;
  check(upperBoundMs <= 120_000);
  return {
    commitAccepted: true,
    canonicalAcknowledged: true,
    entryAndEventCorrelated: true,
    requestStartToAcceptedMs: acceptedAt - requestStartedAt,
    enqueueToAckUpperBoundMs: upperBoundMs,
    within120sMargin: true,
  };
}

/** Retain only actually observed browser timestamps/status, never infer missing values. */
export function boundedManualCommitObservation(value) {
  const boundaries = [
    'commit-requested',
    'commit-response',
    'before-canonical-ack',
    'canonical-acknowledged',
    'browser-finally',
  ];
  if (!value || !boundaries.includes(value.boundary)) return null;
  const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
  return {
    boundary: value.boundary,
    requestStartedAt: time(value.requestStartedAt),
    acceptedAt: time(value.acceptedAt),
    deadline: time(value.deadline),
    status:
      Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599
        ? value.status
        : null,
    entryDigest: /^[a-f0-9]{64}$/.test(value.entryDigest ?? '') ? value.entryDigest : null,
  };
}
/** Captures a fixed controller-private history snapshot; never changes original acknowledgement work. */
export function retainManualCanonicalObservation(records, boundary, snapshot) {
  if (
    !['before-ack', 'ack-completed', 'ack-failed', 'production-failure', 'before-close'].includes(
      boundary,
    )
  )
    throw new Error('PROOF_MANUAL_OBSERVATION_INVALID');
  let record = { boundary, available: false };
  try {
    const value = snapshot(),
      stages = ['received', 'dispatched', 'applied', 'acknowledged'];
    const digest = (v) => (/^[a-f0-9]{64}$/.test(v ?? '') ? v : null);
    record = {
      boundary,
      available: true,
      generation:
        Number.isSafeInteger(value.generation) && value.generation > 0 ? value.generation : null,
      entryDigest: digest(value.entryDigest),
      events: (Array.isArray(value.events) ? value.events : []).slice(0, 4).map((event) => ({
        kind: 'manual_edit_apply',
        stage: stages.includes(event.stage) ? event.stage : 'unavailable',
        history: Array.isArray(event.history)
          ? event.history
              .slice(0, 4)
              .map((stage) => (stages.includes(stage) ? stage : 'unavailable'))
          : [],
        eventDigest: digest(event.eventDigest),
      })),
    };
  } catch {
    /* Observations never replace the original result or error. */
  }
  if (records.length === 16) records.shift();
  records.push(record);
  return record;
}
export async function observeManualAcknowledgement(work, records, snapshot) {
  retainManualCanonicalObservation(records, 'before-ack', snapshot);
  let completed = false;
  try {
    const result = await work();
    completed = true;
    return result;
  } finally {
    retainManualCanonicalObservation(records, completed ? 'ack-completed' : 'ack-failed', snapshot);
  }
}

/** Proof-only startup failure observation: fixed vocabulary, no payload/error text. */
export function retainOwningStartupFailure(
  records,
  boundary,
  error,
  elapsedMs,
  childAlive,
  diagnostic,
) {
  const boundaries = ['captured-initialize', 'owning-admission-work', 'owning-admission-rejection'];
  if (!boundaries.includes(boundary)) return;
  const codes = [
    'LIVE_NATIVE_HANDOFF_UNVERIFIED',
    'LIVE_NATIVE_HANDOFF_TIMEOUT',
    'LIVE_NATIVE_HANDOFF_CWD_UNVERIFIED',
    'CODEX_STARTUP_DISCOVERY_TIMEOUT',
    'CODEX_STARTUP_CANCELLED',
    'CODEX_RPC_TRANSPORT_CLOSED',
    'CODEX_RPC_INPUT_FAILED',
    'CODEX_RPC_OUTPUT_FAILED',
    'LIVE_ADMISSION_UNAVAILABLE',
    'LIVE_CLEANUP_REQUIRED',
    'LIVE_RUNTIME_CAPTURE_CLEANUP_REQUIRED',
    'LIVE_RUNTIME_PROVENANCE_UNAVAILABLE',
    'LIVE_INSTALLED_SOURCE_UNVERIFIED',
  ];
  const code = codes.includes(error?.message)
    ? error.message
    : error?.kind === 'CODEX_JSON_RPC_ERROR'
      ? 'CODEX_JSON_RPC_ERROR'
      : 'UNCLASSIFIED';
  const phases = ['manager-command', 'agents-command'];
  const reasons = [
    'contract-refused',
    'command-failed',
    'source-changed',
    'binary-changed',
    'config-changed',
    'unverified-owning-runtime',
    'unauthorized-controller',
    'stale-runtime-provenance',
  ];
  const row = {
    boundary,
    code,
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : null,
    childAlive: typeof childAlive === 'boolean' ? childAlive : null,
  };
  if (diagnostic && phases.includes(diagnostic.phase)) {
    row.admission = {
      phase: diagnostic.phase,
      reason: reasons.includes(diagnostic.reason) ? diagnostic.reason : 'unclassified-refusal',
    };
  }
  if (records.length >= 16) records.shift();
  records.push(row);
  return row;
}
/** Catch before caller cleanup, preserve the exact original work/error and one dispatch. */
export async function observeOwningStartupFailure(work, record) {
  try {
    return await work();
  } catch (error) {
    try {
      record(error);
    } catch {
      /* Diagnostic failure never replaces work failure. */
    }
    throw error;
  }
}

export function observeOwningAdmissionFailure(run, session, work, record) {
  return observeOwningStartupFailure(
    () =>
      run(session, () =>
        observeOwningStartupFailure(work, (error) => record('owning-admission-work', error)),
      ),
    (error) => record('owning-admission-rejection', error),
  );
}
