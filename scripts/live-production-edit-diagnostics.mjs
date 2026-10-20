/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

// Opt-in observer only: fixed labels/IDs, one kernel clock, original operations.
// Pending rows are not settlement; cancellation never fabricates an end time.
export function createSerialProfile(binding, now = () => process.hrtime.bigint()) {
  const labels = new Set([
    'idempotent-start',
    'poll-authority',
    'generate-authority',
    'event-authority',
    'root-confinement',
    'child-confinement',
    'first-source-patch',
    'accept-ack',
    'post-accept-poll',
    'browser-close',
    'disconnect-ack',
    'disconnect-revoke',
  ]);
  if (
    !['serial-accept-baseline-1', 'deferred-accept-confinement-1'].includes(binding?.trialId) ||
    !/^[0-9]{1,24}$/.test(binding.anchor?.monotonicNs ?? '')
  )
    throw Error('PROOF_PROFILE_INVALID');
  binding = structuredClone(binding);
  const exact = (value, keys) =>
    value && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const hex = (value, length) =>
    typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
  if (
    !exact(binding, ['trialId', 'identity', 'birth', 'anchor', 'phaseA']) ||
    !exact(binding.identity, [
      'candidate',
      'tree',
      'runId',
      'native',
      'manager',
      'managerTree',
      'agents',
    ]) ||
    !['candidate', 'tree', 'managerTree', 'agents'].every((k) => hex(binding.identity[k], 40)) ||
    !['native', 'manager'].every((k) => hex(binding.identity[k], 64)) ||
    !/^[1-9][0-9]{0,20}$/.test(binding.identity.runId) ||
    !exact(binding.birth, ['pid', 'start', 'boot']) ||
    !Number.isSafeInteger(binding.birth.pid) ||
    binding.birth.pid <= 0 ||
    !/^[0-9]{1,24}$/.test(binding.birth.start) ||
    !/^[a-f0-9-]{36}$/.test(binding.birth.boot) ||
    !exact(binding.anchor, ['boot', 'monotonicNs']) ||
    binding.anchor.boot !== binding.birth.boot ||
    !exact(binding.phaseA, ['phase', 'startedNs', 'deadlineNs']) ||
    binding.phaseA.phase !== 'accepted' ||
    !['startedNs', 'deadlineNs'].every((k) => /^[0-9]{1,24}$/.test(binding.phaseA[k])) ||
    BigInt(binding.phaseA.startedNs) < BigInt(binding.anchor.monotonicNs) ||
    BigInt(binding.phaseA.deadlineNs) > BigInt(binding.anchor.monotonicNs) + 1_380_000_000_000n ||
    BigInt(binding.phaseA.deadlineNs) > BigInt(binding.phaseA.startedNs) + 1_260_000_000_000n
  )
    throw Error('PROOF_PROFILE_INVALID');
  const report = {
    schemaVersion: 1,
    scheduling:
      binding.trialId === 'serial-accept-baseline-1'
        ? 'unchanged-serial'
        : 'deferred-reuse-before-source-patch',
    attempt: 1,
    binding: structuredClone(binding),
    spans: [],
    firstFailure: null,
  };
  const invalid = () => {
    report.firstFailure ??= { code: 'PROOF_PROFILE_INVALID', observedNs: null };
    throw Error('PROOF_PROFILE_INVALID');
  };
  const scope = new AsyncLocalStorage(),
    rows = new Map();
  const clock = (value = now()) => {
    if (typeof value !== 'bigint' || value < BigInt(binding.anchor.monotonicNs) || value > now())
      invalid();
    return value.toString();
  };
  const begin = (label, metadata = {}, at) => {
    if (
      !labels.has(label) ||
      rows.size >= 128 ||
      Object.keys(metadata).some((k) => !['parentId', 'generation', 'eventDigest'].includes(k)) ||
      (metadata.parentId !== undefined && !rows.has(metadata.parentId)) ||
      (metadata.generation !== undefined &&
        (!Number.isSafeInteger(metadata.generation) || metadata.generation <= 0)) ||
      (metadata.eventDigest !== undefined && !/^[a-f0-9]{64}$/.test(metadata.eventDigest))
    ) {
      report.firstFailure ??= { code: 'PROOF_PROFILE_INVALID', observedNs: null };
      invalid();
    }
    const id = `profile-${String(rows.size + 1).padStart(4, '0')}`;
    const row = {
      id,
      label,
      ...structuredClone(metadata),
      startNs: clock(at),
      endNs: null,
      outcome: 'pending',
    };
    rows.set(id, row);
    report.spans.push(row);
    return id;
  };
  const end = (id, outcome, at) => {
    const row = rows.get(id),
      endNs = clock(at);
    if (
      !row ||
      row.endNs !== null ||
      !['completed', 'refused'].includes(outcome) ||
      BigInt(endNs) < BigInt(row.startNs)
    )
      invalid();
    Object.assign(row, { endNs, outcome });
  };
  const trace = (label, work, metadata = {}) => {
    const parentId = scope.getStore();
    const id = begin(label, { ...(parentId ? { parentId } : {}), ...metadata });
    return scope.run(id, () => {
      try {
        const raw = work();
        if (raw && typeof raw.then === 'function') {
          raw
            .then(
              () => end(id, 'completed'),
              () => end(id, 'refused'),
            )
            .catch(() => {
              report.firstFailure ??= { code: 'PROOF_PROFILE_INVALID', observedNs: null };
            });
          return raw;
        }
        end(id, 'completed');
        return raw;
      } catch (error) {
        end(id, 'refused');
        throw error;
      }
    });
  };
  return {
    report,
    begin,
    end,
    trace,
    currentId: () => scope.getStore() ?? null,
    granted() {
      const row = rows.get(scope.getStore());
      if (!row || row.grantedNs !== undefined) invalid();
      row.grantedNs = clock();
    },
    eventParent(eventDigest) {
      const matches = report.spans.filter(
        (r) =>
          r.label === 'generate-authority' &&
          r.eventDigest === eventDigest &&
          r.grantedNs !== undefined,
      );
      if (matches.length !== 1) invalid();
      return matches[0].id;
    },
    failure(code) {
      if (
        ![
          'PROOF_CANCELLED',
          'PROOF_DRIVER_PHASE_DEADLINE',
          'PROOF_OBSERVATION_DEADLINE',
          'PROOF_EDIT_BUDGET_INSUFFICIENT',
        ].includes(code)
      )
        return;
      report.firstFailure ??= { code, observedNs: clock() };
    },
  };
}

/** One existing API operation, admitted only by a real Generate grant. Observation
 * cancellation never retires its lifetime or releases a later source mutation. */
export function createDeferredSourceGate({ assertCurrent, authorize, work, validate }) {
  let raw,
    joined,
    passed = false,
    started = false;
  return {
    start(authority) {
      if (started) throw new Error('PROOF_REUSE_REPLAY');
      started = true;
      assertCurrent();
      authorize(authority);
      raw = work(authority);
      if (!raw || typeof raw.then !== 'function') throw new Error('PROOF_REUSE_INVALID');
      joined = raw.then((value) => {
        assertCurrent();
        validate(value);
        passed = true;
        return value;
      });
      joined.catch(() => {});
      return raw;
    },
    async beforeSourcePatch() {
      assertCurrent();
      if (!joined) throw new Error('PROOF_REUSE_NOT_STARTED');
      await joined;
      this.assertPassed();
    },
    assertPassed() {
      assertCurrent();
      if (!passed) throw new Error('PROOF_REUSE_UNVERIFIED');
    },
    async drain() {
      if (raw) await Promise.allSettled([raw, joined]);
    },
  };
}

/** Profile-trial acceptance only. Ordinary lane assertions remain independent. */
export function validateSerialProfile(report) {
  const check = (value) => {
    if (!value) throw Error('PROOF_PROFILE_INVALID');
  };
  check(
    report?.schemaVersion === 1 &&
      report.scheduling ===
        (report.binding?.trialId === 'serial-accept-baseline-1'
          ? 'unchanged-serial'
          : 'deferred-reuse-before-source-patch') &&
      report.attempt === 1 &&
      report.firstFailure === null,
  );
  createSerialProfile(report.binding); // Same strict payload-free identity schema.
  const labels = new Set([
    'idempotent-start',
    'generate-authority',
    'root-confinement',
    'child-confinement',
    'first-source-patch',
    'accept-ack',
    'post-accept-poll',
    'browser-close',
    'disconnect-ack',
    'disconnect-revoke',
    'poll-authority',
    'event-authority',
  ]);
  const rows = report.spans;
  check(Array.isArray(rows) && rows.length > 0 && rows.length <= 128);
  const seen = new Set(),
    number = (value) => typeof value === 'string' && /^[0-9]{1,24}$/.test(value);
  for (const [index, row] of rows.entries()) {
    check(
      labels.has(row.label) &&
        Object.keys(row).every((key) =>
          [
            'id',
            'label',
            'startNs',
            'endNs',
            'outcome',
            'generation',
            'parentId',
            'eventDigest',
            'grantedNs',
          ].includes(key),
        ),
    );
    check(
      row.generation === undefined || (Number.isSafeInteger(row.generation) && row.generation > 0),
    );
    check(row.eventDigest === undefined || /^[a-f0-9]{64}$/.test(row.eventDigest));
    check(row.id === `profile-${String(index + 1).padStart(4, '0')}` && !seen.has(row.id));
    check(
      number(row.startNs) &&
        number(row.endNs) &&
        BigInt(row.startNs) >= BigInt(report.binding.anchor.monotonicNs) &&
        BigInt(row.endNs) >= BigInt(row.startNs),
    );
    check(['completed', 'refused'].includes(row.outcome));
    check(row.parentId === undefined || seen.has(row.parentId));
    check(
      row.grantedNs === undefined ||
        (number(row.grantedNs) &&
          BigInt(row.grantedNs) >= BigInt(row.startNs) &&
          BigInt(row.grantedNs) <= BigInt(row.endNs)),
    );
    seen.add(row.id);
  }
  const one = (label) => {
    const found = rows.filter((row) => row.label === label);
    check(found.length === 1 && found[0].outcome === 'completed');
    check(BigInt(found[0].endNs) <= BigInt(report.binding.phaseA.deadlineNs));
    return found[0];
  };
  const required = Object.fromEntries(
    [
      'idempotent-start',
      'generate-authority',
      'root-confinement',
      'child-confinement',
      'first-source-patch',
      'accept-ack',
      'post-accept-poll',
      'browser-close',
      'disconnect-ack',
      'disconnect-revoke',
    ].map((label) => [label, one(label)]),
  );
  const owner = report.originalOwner;
  check(
    owner &&
      Object.keys(owner).sort().join(',') ===
        ['liveDigest', 'generation', 'rootThreadDigest', 'captureDigest', 'nativeBirthDigest']
          .sort()
          .join(','),
  );
  check(
    ['liveDigest', 'rootThreadDigest', 'captureDigest', 'nativeBirthDigest'].every((key) =>
      /^[a-f0-9]{64}$/.test(owner[key]),
    ) &&
      Number.isSafeInteger(owner.generation) &&
      owner.generation > 0,
  );
  const generate = required['generate-authority'],
    root = required['root-confinement'],
    child = required['child-confinement'],
    patch = required['first-source-patch'];
  check(
    generate.grantedNs !== undefined &&
      generate.generation === owner.generation &&
      required['idempotent-start'].generation === owner.generation,
  );
  check(root.parentId === generate.id && child.parentId === root.id && patch.parentId === root.id);
  check(
    BigInt(generate.grantedNs) <= BigInt(root.startNs) &&
      (report.scheduling === 'unchanged-serial'
        ? BigInt(required['idempotent-start'].endNs) <= BigInt(generate.grantedNs)
        : BigInt(required['idempotent-start'].startNs) >= BigInt(root.startNs) &&
          BigInt(required['idempotent-start'].endNs) <= BigInt(patch.startNs)),
  );
  check(
    BigInt(root.startNs) <= BigInt(child.startNs) &&
      BigInt(child.endNs) <= BigInt(root.endNs) &&
      BigInt(root.endNs) <= BigInt(patch.startNs),
  );
  for (const [before, after] of [
    ['first-source-patch', 'accept-ack'],
    ['accept-ack', 'post-accept-poll'],
    ['post-accept-poll', 'browser-close'],
    ['browser-close', 'disconnect-ack'],
    ['disconnect-ack', 'disconnect-revoke'],
  ])
    check(BigInt(required[before].endNs) <= BigInt(required[after].endNs));
  check(
    rows.some(
      (row) =>
        row.label === 'poll-authority' &&
        row.grantedNs !== undefined &&
        row.generation === owner.generation &&
        BigInt(row.grantedNs) <= BigInt(generate.grantedNs),
    ),
  );
  return true;
}

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

// Measured next-poll + Generate + exit-poll PROXY for Discard + UI reserve.
// This is a refusal threshold, never a promise of Discard timing or a new cap.
// Actual run39499281719 proxy costs, not guaranteed upper bounds. Initial Generate
// reserve includes its browser prelude/UI; post-close keeps both existing30s caps.
export const acceptedLeaseEstimate = Object.freeze({
  generate: 304_719 - 80_958 + 30_000,
  accept: 80_958 + 113_678 + 60_000 + 15_000,
  'post-accept': 113_678 + 60_000 + 15_000,
});
export function acceptedLeaseDeadline(input) {
  const now = input.now ?? Date.now();
  const epoch = (value) => {
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const cookie = epoch(input.cookie?.cookieExpiresAt);
  const server = epoch(input.lease?.leaseExpiresAt);
  const absolute = epoch(input.lease?.absoluteExpiresAt);
  const host = Number.isSafeInteger(input.hostDeadline) ? input.hostDeadline : null;
  const valid =
    Number.isSafeInteger(now) &&
    now >= 0 &&
    Number.isSafeInteger(input.requiredMs) &&
    input.requiredMs > 0 &&
    Number.isSafeInteger(input.generation) &&
    input.generation > 0 &&
    input.lease?.generation === input.generation &&
    /^[a-f0-9]{64}$/.test(input.cookie?.tokenDigest ?? '') &&
    input.lease?.tokenDigest === input.cookie.tokenDigest &&
    [cookie, server, absolute].every((value) => value !== null && value > now) &&
    host !== null;
  const deadline = [cookie, server, absolute, host].every((value) => value !== null)
    ? Math.min(cookie, server, absolute, host) - 15_000
    : null;
  // Payload-free observations precede every identity/capacity refusal. No caller
  // strings, tokens or raw errors cross this existing browser reporting path.
  input.observeCapacity?.({
    boundary: ['before-generate', 'before-accept', 'generate', 'accept', 'post-accept'].includes(
      input.boundary,
    )
      ? input.boundary
      : 'invalid',
    sampledAt: Number.isSafeInteger(now) && now >= 0 ? now : null,
    cookieExpiresAt: cookie === null ? null : new Date(cookie).toISOString(),
    leaseExpiresAt: server === null ? null : new Date(server).toISOString(),
    absoluteExpiresAt: absolute === null ? null : new Date(absolute).toISOString(),
    hostDeadline: host,
    deadline,
    estimateMs:
      Number.isSafeInteger(input.requiredMs) && input.requiredMs > 0 ? input.requiredMs : null,
    remainingMs:
      deadline === null || !Number.isSafeInteger(now) ? null : Math.max(0, deadline - now),
    capacityInputsValid: valid,
    costsAreMeasuredProxies: true,
  });
  if (!valid) throw new Error('PROOF_ACCEPTED_LEASE_INVALID');
  if (deadline - now < input.requiredMs) throw new Error('PROOF_ACCEPTED_LEASE_INSUFFICIENT');
  return deadline;
}
export function boundedAcceptedLeaseCapacityObservations(rows) {
  const keys = [
    'boundary',
    'sampledAt',
    'cookieExpiresAt',
    'leaseExpiresAt',
    'absoluteExpiresAt',
    'hostDeadline',
    'deadline',
    'estimateMs',
    'remainingMs',
    'capacityInputsValid',
    'costsAreMeasuredProxies',
  ];
  const number = (v) => v === null || (Number.isSafeInteger(v) && v >= 0);
  const date = (v) =>
    v === null ||
    (typeof v === 'string' &&
      Number.isFinite(Date.parse(v)) &&
      new Date(Date.parse(v)).toISOString() === v);
  return (Array.isArray(rows) ? rows : [])
    .slice(0, 8)
    .filter(
      (row) =>
        row &&
        Object.keys(row).sort().join(',') === [...keys].sort().join(',') &&
        [
          'before-generate',
          'before-accept',
          'generate',
          'accept',
          'post-accept',
          'invalid',
        ].includes(row.boundary) &&
        ['sampledAt', 'hostDeadline', 'deadline', 'estimateMs', 'remainingMs'].every((key) =>
          number(row[key]),
        ) &&
        ['cookieExpiresAt', 'leaseExpiresAt', 'absoluteExpiresAt'].every((key) => date(row[key])) &&
        typeof row.capacityInputsValid === 'boolean' &&
        row.costsAreMeasuredProxies === true,
    )
    .map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])));
}
export async function renewAcceptedPreviewLease(input) {
  let capacityRefusal,
    lastLease,
    lastCookie = input.cookie;
  try {
    return await renewManualPreviewLease({
      ...input,
      renew: async (...args) => {
        lastLease = await input.renew(...args);
        return lastLease;
      },
      readCookie: async () => {
        lastCookie = await input.readCookie();
        return lastCookie;
      },
      capacity: (observed) => {
        try {
          return acceptedLeaseDeadline({
            ...observed,
            boundary: input.stage,
            observeCapacity: input.observeCapacity,
          });
        } catch (error) {
          capacityRefusal = error;
          throw error;
        }
      },
    });
  } catch (error) {
    if (!capacityRefusal) {
      // Preserve the last actual observations even when identity/redelivery
      // validation refuses before the final capacity check can run.
      try {
        acceptedLeaseDeadline({
          cookie: lastCookie,
          lease: lastLease,
          generation: input.generation,
          hostDeadline: input.hostDeadline,
          requiredMs: input.requiredMs ?? manualLeaseEstimate.generate,
          now: (input.now ?? Date.now)(),
          boundary: input.stage,
          observeCapacity: input.observeCapacity,
        });
      } catch {
        /* Observation never converts the original refusal into authority. */
      }
    }
    // Only our exact local validator's insufficient-capacity error qualifies.
    // An adapter throwing the same message (or a payload-bearing prefix) does not.
    if (error === capacityRefusal && error?.message === 'PROOF_ACCEPTED_LEASE_INSUFFICIENT')
      throw error;
    throw new Error('PROOF_ACCEPTED_LEASE_INVALID');
  }
}
export const manualLeaseEstimate = Object.freeze({
  generate: 87_260 + 79_394 + 30_000,
  discard: 74_270 + 87_260 + 30_000,
  'post-discard': 87_260 + 30_000,
});
// The explicitly issued extra-owner probe is the only expected helper refusal.
// Match its actual Playwright request object, never a route/status heuristic.
export function expectedPollProbeResponse(response, originalRequest, origin) {
  const request = response.request();
  return (
    !!originalRequest &&
    request === originalRequest &&
    request.method() === 'GET' &&
    request.url() === `${origin}/__gestalt_live/poll` &&
    response.status() === 403
  );
}
export function boundedHelperAuthLoss(value) {
  const sample = (item) =>
    item &&
    Number.isSafeInteger(item.elapsedMs) &&
    item.elapsedMs >= 0 &&
    Number.isSafeInteger(item.status) &&
    item.status >= 100 &&
    item.status <= 599
      ? {
          elapsedMs: item.elapsedMs,
          status: item.status,
          route: [
            'live.js',
            'events',
            'status',
            'lease',
            'agent-target-claim',
            'manual-edit-stash',
            'manual-edit-commit',
            'poll',
          ].includes(item.route)
            ? item.route
            : 'other',
          cookiePresent: item.cookiePresent === true,
          helperTokenMatches:
            typeof item.helperTokenMatches === 'boolean' ? item.helperTokenMatches : null,
        }
      : null;
  const first = sample(value?.first);
  return first && [401, 403].includes(first.status)
    ? { previous: sample(value.previous), first }
    : null;
}
export function previewCookieObservation(cookies, origin, now = Date.now()) {
  const url = new URL(origin);
  const name = `__Host-gestalt_live_p${url.port || '443'}`;
  const matches = cookies.filter((item) => item.name === name);
  const cookie = matches[0];
  if (
    url.protocol !== 'https:' ||
    matches.length !== 1 ||
    cookie.domain !== url.hostname ||
    cookie.path !== '/' ||
    cookie.secure !== true ||
    cookie.httpOnly !== true ||
    !/^[A-Za-z0-9_-]{43}$/.test(cookie.value) ||
    !Number.isFinite(cookie.expires) ||
    cookie.expires * 1000 <= now
  )
    throw new Error('PROOF_MANUAL_COOKIE_INVALID');
  return {
    tokenDigest: createHash('sha256').update(cookie.value).digest('hex'),
    cookieExpiresAt: new Date(Math.floor(cookie.expires * 1000)).toISOString(),
  };
}
export function assertPreviewLeaseIdentity(lease, cookie, audience, now = Date.now()) {
  if (
    !lease ||
    !/^[a-f0-9]{64}$/.test(cookie?.tokenDigest ?? '') ||
    lease.tokenHash !== cookie.tokenDigest ||
    Object.entries(audience).some(([key, value]) => lease[key] !== value) ||
    !Number.isFinite(Date.parse(cookie.cookieExpiresAt)) ||
    Math.min(
      Date.parse(cookie.cookieExpiresAt),
      Date.parse(lease.leaseExpiresAt),
      Date.parse(lease.absoluteExpiresAt),
    ) <= now ||
    !Number.isFinite(Date.parse(lease.leaseExpiresAt)) ||
    !Number.isFinite(Date.parse(lease.absoluteExpiresAt))
  )
    throw new Error('PROOF_MANUAL_LEASE_IDENTITY');
}
export function manualLeaseDeadline({
  cookie,
  lease,
  generation,
  hostDeadline,
  requiredMs,
  now = Date.now(),
}) {
  const deadline =
    Math.min(
      hostDeadline,
      Date.parse(cookie?.cookieExpiresAt),
      Date.parse(lease?.leaseExpiresAt),
      Date.parse(lease?.absoluteExpiresAt),
    ) - 15_000;
  if (
    lease?.generation !== generation ||
    lease?.tokenDigest !== cookie?.tokenDigest ||
    !Number.isSafeInteger(requiredMs) ||
    requiredMs <= 0 ||
    !Number.isFinite(deadline) ||
    deadline - now < requiredMs
  )
    throw new Error('PROOF_MANUAL_LEASE_INSUFFICIENT');
  return deadline;
}
export async function renewManualPreviewLease({
  cookie,
  renew,
  redeliver,
  readCookie,
  generation,
  hostDeadline,
  requiredMs = manualLeaseEstimate.generate,
  stage = 'before-generate',
  now = Date.now,
  capacity = manualLeaseDeadline,
}) {
  const deadline = Math.min(now() + 30_000, hostDeadline, Date.parse(cookie.cookieExpiresAt));
  const lease = await withinProofObservation(() => renew(cookie, deadline), deadline, now);
  if (
    lease?.generation !== generation ||
    lease?.stage !== stage ||
    typeof lease?.renewed !== 'boolean' ||
    lease?.tokenDigest !== cookie.tokenDigest ||
    lease.absoluteExpiresAt !== lease.priorAbsoluteExpiresAt
  )
    throw new Error('PROOF_MANUAL_LEASE_IDENTITY');
  const actual =
    lease.renewed === false ? lease : await withinProofObservation(redeliver, deadline, now);
  const current = await withinProofObservation(readCookie, deadline, now);
  proofObservationRemaining(deadline, now());
  if (
    current.tokenDigest !== cookie.tokenDigest ||
    actual.leaseExpiresAt !== lease.leaseExpiresAt ||
    actual.absoluteExpiresAt !== lease.absoluteExpiresAt ||
    (lease.renewed !== false &&
      Date.parse(current.cookieExpiresAt) <= Date.parse(cookie.cookieExpiresAt)) ||
    Date.parse(current.cookieExpiresAt) > Date.parse(lease.leaseExpiresAt) + 1000 ||
    Date.parse(lease.leaseExpiresAt) - now() > 300_000
  )
    throw new Error('PROOF_MANUAL_LEASE_IDENTITY');
  capacity({
    cookie: current,
    lease,
    generation,
    hostDeadline,
    requiredMs,
    now: now(),
  });
  return { cookie: current, lease };
}

/** A timed-out UI step stays owned until it and context closure actually settle.
 * Every later step is fenced; Promise.race alone cannot prevent a late click. */
export async function ownedProofSequence({
  steps,
  deadline,
  abort,
  observe = () => {},
  now = Date.now,
}) {
  const remaining = proofObservationRemaining(deadline, now());
  let expired = false,
    timer;
  const check = () => {
    if (expired) throw new Error('PROOF_OBSERVATION_DEADLINE');
    proofObservationRemaining(deadline, now());
  };
  const pending = (async () => {
    for (const step of steps) {
      check();
      await step();
      check();
    }
  })();
  const settled = pending.then(
    () => ({ ok: true }),
    (error) => ({ error }),
  );
  try {
    const result = await Promise.race([
      settled,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve({ timeout: true });
        }, remaining);
      }),
    ]);
    if (result.timeout) {
      observe({ timedOut: true, pendingOwned: true, drained: false });
      // Closing the actual context cancels an in-flight Playwright action. Do
      // not release ownership or begin later editing steps while it is pending.
      const [closed] = await Promise.allSettled([Promise.resolve().then(abort), settled]);
      observe({
        timedOut: true,
        pendingOwned: false,
        drained: true,
        contextClosed: closed.status === 'fulfilled',
      });
      throw new Error('PROOF_OBSERVATION_DEADLINE');
    }
    if (result.error) throw result.error;
  } finally {
    clearTimeout(timer);
  }
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
  // Preserve only these exact payload-free A refusals; token redaction otherwise
  // erases the insufficient-capacity outcome needed to decide this one trial.
  if (
    [
      'PROOF_ACCEPTED_LEASE_INSUFFICIENT',
      'PROOF_ACCEPTED_LEASE_INVALID',
      'PROOF_ACCEPTED_LEASE_REDELIVERY',
    ].includes(message)
  )
    return message;
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
export function observeEventAuthority(target, records, closureBoundary, profile) {
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
  target.liveEvent = function (fence, eventId, work) {
    const invoke = async () => {
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
          profile?.granted?.();
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
    return profile?.trace ? profile.trace(fence, eventId, invoke) : invoke();
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
export function observeInstalledPolicyTimings(prototype, correlation = () => null) {
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
      const profileId = correlation();
      if (/^profile-[0-9]{4}$/.test(profileId ?? '')) record.profileId = profileId;
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
export function observeAdmissionTimings(
  runtimePrototype,
  controllerPrototype,
  correlation = () => null,
) {
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
      const profileId = correlation();
      if (/^profile-[0-9]{4}$/.test(profileId ?? '')) record.profileId = profileId;
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
