/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Fixture contract tests; these do not claim actual Native model execution.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  safeBrowserFailure,
  observePreviewExchange,
  pickerChromeSnapshot,
  boundedPickerObservation,
  observeProofMethod,
  observeEventAuthority,
  proofObservationRemaining,
  withinProofObservation,
  pickerContinuityProbe,
  observePickerContinuity,
  observeCanonicalPollDispatch,
  observePostAcceptPollDispatch,
  manualObservationDeadline,
  verifyManualAcknowledgement,
  retainOwningStartupFailure,
  observeOwningStartupFailure,
  observeOwningAdmissionFailure,
  boundedManualCommitObservation,
  retainManualCanonicalObservation,
  observeManualAcknowledgement,
  observeInstalledPolicyTimings,
  observeAdmissionTimings,
  cleanupControllerSnapshot,
  createSerialProfile,
  editingSchedule,
  editingRemaining,
  requireEditingBudget,
  drainEditingFailure,
  editingLeaseCapacity,
  observeEditingSteer,
  assertOldPreviewCookieDenied,
  previewCookieObservation,
  assertPreviewLeaseIdentity,
  renewManualPreviewLease,
  manualLeaseDeadline,
  manualLeaseEstimate,
  boundedHelperAuthLoss,
  expectedPollProbeResponse,
  ownedProofSequence,
} from './live-production-edit-diagnostics.mjs';
import { JSDOM } from 'jsdom';
import {
  processBirth,
  proofPins,
  birthCurrent,
  openRecoveryHandoff,
  editingPhaseBound,
} from './live-production-proof-lanes.mjs';
import {
  createProductionEditProvider,
  productionModelWorkload,
  withoutProofInjection,
  failureStopOperation,
  liveEventFromRequest,
} from './live-production-edit-provider.mjs';

function body(event) {
  return {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Untrusted event:\n' + JSON.stringify(event) }],
      },
    ],
  };
}
const tool = (name, args) => ({ name, args });
test('browser diagnostics remove private grants, cookies and bearer canaries', () => {
  const bearer = 'bearer-canary-'.repeat(4);
  const diagnostic = safeBrowserFailure(
    `page.waitForURL: net::ERR_HTTP2_PROTOCOL_ERROR at https://preview.test/auth#grant=${bearer} cookie=${bearer}\nprivate stack`,
  );
  assert.ok(diagnostic.includes('net::ERR_HTTP2_PROTOCOL_ERROR'));
  assert.ok(!diagnostic.includes(bearer));
  assert.ok(!diagnostic.includes('preview.test'));
  assert.ok(!diagnostic.includes('private stack'));
});
const final = (_id, text) => JSON.parse(text);
function simulatePatch(root, call) {
  assert.equal(call.name, 'apply_patch');
  const lines = call.args.split('\n');
  const file = lines.find((line) => line.startsWith('*** Update File: ')).slice(17);
  assert.ok(file.startsWith(root + '/'));
  const removed = lines
    .filter((line) => line.startsWith('-'))
    .map((line) => line.slice(1))
    .join('\n');
  const added = lines
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1))
    .join('\n');
  const source = readFileSync(file, 'utf8');
  assert.equal(source.split(removed).length, 2);
  writeFileSync(file, source.replace(removed, added));
}
test('controlled Native patch plan interoperates with the actual pinned helper wrap, accept and discard', () => {
  const helper = process.env.LIVE_TEST_IMPECCABLE;
  assert.equal(
    createHash('sha256').update(readFileSync(helper)).digest('hex'),
    '81fe24a7430571de1003f34fecf787bdc0acefa1be80525ccea9d4b74b5441a0',
  );
  const root = mkdtempSync(join(tmpdir(), 'l11-edit-contract-'));
  try {
    mkdirSync(join(root, '.impeccable/live'), { recursive: true });
    writeFileSync(
      join(root, '.impeccable/live/config.json'),
      JSON.stringify({ files: ['index.html'], insertBefore: '</body>', commentSyntax: 'html' }),
    );
    writeFileSync(
      join(root, 'index.html'),
      '<html>\n<body>\n<h1 class="hero-title">Owning app</h1>\n<script src="/live.js?token=unrelated-bootstrap-canary"></script>\n</body>\n</html>\n',
    );
    const run = (args) =>
      JSON.parse(
        execFileSync(helper, [...args, '--target', root], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        })
          .trim()
          .split('\n')
          .at(-1),
      );
    const provider = createProductionEditProvider(root, final, {});
    const generate = (id, text) => {
      const scaffold = run([
        'live-wrap',
        '--id',
        id,
        '--count',
        '2',
        '--classes',
        'hero-title',
        '--tag',
        'h1',
        '--text',
        text,
        '--defer-source-write',
      ]);
      const request = body({ type: 'generate', id, count: 2, scaffold });
      const patch = provider(request, tool);
      assert.ok(!patch.args.includes('unrelated-bootstrap-canary'));
      simulatePatch(root, patch);
      assert.equal(provider(request, tool).status, 'done');
    };
    generate('1234abcd', 'Owning app');
    const accepted = run(['live-accept', '--id', '1234abcd', '--variant', '1']);
    assert.equal(accepted.handled, true);
    const acceptedSource = readFileSync(join(root, 'index.html'), 'utf8');
    assert.ok(acceptedSource.includes('Production chosen variant'));
    assert.ok(!acceptedSource.includes('impeccable-variants-start'));
    writeFileSync(join(root, 'app.js'), "export const marker = 'original';\n");
    const steer = body({ type: 'steer', id: '1234abce', message: 'production steer' });
    simulatePatch(root, provider(steer, tool));
    assert.equal(provider(steer, tool).status, 'steer_done');
    const manual = body({
      type: 'manual_edit_apply',
      id: '1234abcf',
      batch: {
        entries: [
          {
            id: 'entry-1',
            ops: [
              { originalText: 'Production chosen variant', newText: 'Production manual approved' },
            ],
          },
        ],
      },
    });
    simulatePatch(root, provider(manual, tool));
    assert.deepEqual(provider(manual, tool).data.appliedEntryIds, ['entry-1']);
    const manualSource = readFileSync(join(root, 'index.html'), 'utf8');
    generate('1234abd0', 'Production manual approved');
    const discarded = run(['live-accept', '--id', '1234abd0', '--discard']);
    assert.equal(discarded.handled, true);
    assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), manualSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('controlled provider rejects an authentication token in model request event content', () => {
  assert.throws(() =>
    liveEventFromRequest(
      body({ type: 'generate', id: '1234abcd', token: 'must-not-reach-provider' }),
    ),
  );
});

test('manual-first lane plans a real source patch then actual helper Generate/Discard restores that exact manual result', () => {
  const helper = process.env.LIVE_TEST_IMPECCABLE;
  assert.equal(
    createHash('sha256').update(readFileSync(helper)).digest('hex'),
    '81fe24a7430571de1003f34fecf787bdc0acefa1be80525ccea9d4b74b5441a0',
  );
  const root = mkdtempSync(join(tmpdir(), 'l11-manual-discard-contract-'));
  try {
    mkdirSync(join(root, '.impeccable/live'), { recursive: true });
    writeFileSync(
      join(root, '.impeccable/live/config.json'),
      JSON.stringify({ files: ['index.html'], insertBefore: '</body>', commentSyntax: 'html' }),
    );
    writeFileSync(
      join(root, 'index.html'),
      '<html>\n<body>\n<h1 class="hero-title">Owning app</h1>\n</body>\n</html>\n',
    );
    const run = (args) =>
      JSON.parse(
        execFileSync(helper, [...args, '--target', root], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        })
          .trim()
          .split('\n')
          .at(-1),
      );
    const provider = createProductionEditProvider(root, final, {}, { lane: 'manual-discard' });
    const manual = body({
      type: 'manual_edit_apply',
      id: 'abcd1234',
      batch: {
        entries: [
          {
            id: 'real-draft',
            ops: [{ originalText: 'Owning app', newText: 'Production manual approved' }],
          },
        ],
      },
    });
    const patch = provider(manual, tool);
    assert.equal(
      readFileSync(join(root, 'index.html'), 'utf8').includes('Production manual approved'),
      false,
    );
    simulatePatch(root, patch);
    assert.deepEqual(provider(manual, tool).data.appliedEntryIds, ['real-draft']);
    const manualSource = readFileSync(join(root, 'index.html'), 'utf8');
    const scaffold = run([
      'live-wrap',
      '--id',
      'abcd1235',
      '--count',
      '2',
      '--classes',
      'hero-title',
      '--tag',
      'h1',
      '--text',
      'Production manual approved',
      '--defer-source-write',
    ]);
    const generate = body({ type: 'generate', id: 'abcd1235', count: 2, scaffold });
    simulatePatch(root, provider(generate, tool));
    assert.equal(provider(generate, tool).status, 'done');
    assert.ok(
      readFileSync(join(root, 'index.html'), 'utf8').includes('Production discarded variant'),
    );
    assert.equal(run(['live-accept', '--id', 'abcd1235', '--discard']).handled, true);
    assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), manualSource);
    assert.throws(() => createProductionEditProvider(root, final, {}, { lane: 'unreviewed' }));
    writeFileSync(join(root, 'index.html'), '<h1>Unexpected source</h1>');
    const changed = createProductionEditProvider(root, final, {}, { lane: 'manual-discard' });
    assert.throws(() => changed(manual, tool));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('picker snapshots distinguish absent, hidden and separate chrome roots without retaining DOM text or helper secrets', () => {
  const dom = new JSDOM(
    '<div id="impeccable-live-global-bar" style="display:none"><div id="impeccable-live-page-chat">canary-private-DOM</div></div>',
    { runScripts: 'outside-only' },
  );
  try {
    dom.window.__IMPECCABLE_LIVE_CHROME_CORE__ = {
      debugState: () => ({ state: 'PICKING', savedSession: 'canary-private-session' }),
    };
    dom.window.__productionHelperHideLiveBar = true;
    const snapshot = () => dom.window.eval('(' + pickerChromeSnapshot.toString() + ')()');
    const hidden = snapshot();
    assert.equal(hidden.globalBar.displayNone, true);
    assert.equal(hidden.pageChat.present, true);
    assert.equal(hidden.hideLiveBar, true);
    const fragment = dom.window.document.createDocumentFragment();
    fragment.append(dom.window.document.querySelector('#impeccable-live-page-chat'));
    dom.window.__IMPECCABLE_LIVE_UI_ROOT__ = fragment;
    const separate = snapshot();
    assert.equal(separate.pageChat.present, true);
    assert.equal(separate.pageChatInDocument, false);
    fragment.firstChild.getBoundingClientRect = () => ({
      width: 104,
      height: 28,
      left: 2,
      top: 2,
      right: 106,
      bottom: 30,
    });
    assert.equal(snapshot().pageChat.intersectsViewport, true);
    fragment.firstChild.remove();
    assert.equal(snapshot().pageChat.present, false);
    dom.window.__IMPECCABLE_LIVE_CHROME_CORE__.debugState = () => ({
      state: 'canary-private-state',
    });
    assert.equal(snapshot().helperState, 'unknown');
    assert.ok(!JSON.stringify([hidden, separate, snapshot()]).includes('canary-private'));
  } finally {
    dom.window.close();
  }
});
test('host picker observations accept only fixed boundaries and bounded facts from untrusted browser data', () => {
  const value = boundedPickerObservation({
    boundary: 'before-steer',
    navigationCount: 9,
    available: true,
    helperState: 'canary-private',
    hideLiveBar: 'canary-private',
    globalBar: { present: true, width: 1e99, text: 'canary-private' },
    pageChat: { width: 104, height: 28 },
    url: 'canary-private',
  });
  assert.equal(value.helperState, 'unknown');
  assert.equal(value.hideLiveBar, null);
  assert.equal(value.globalBar.width, null);
  assert.equal(value.pageChat.width, 104);
  assert.ok(!JSON.stringify(value).includes('canary-private'));
  assert.equal(boundedPickerObservation({ boundary: 'canary-private' }), null);
});
test('cleanup observations preserve receiver, arguments, synchronous values, exact promise identity and one original cancellation', async () => {
  const records = [],
    token = {},
    result = {};
  let called = 0,
    cancelled = 0,
    complete;
  const promise = new Promise((resolve) => {
    complete = resolve;
  });
  const target = {
    sync(arg) {
      assert.equal(this, target);
      assert.equal(arg, token);
      called++;
      return result;
    },
    stop(signal) {
      called++;
      signal.addEventListener(
        'abort',
        () => {
          cancelled++;
          complete(result);
        },
        { once: true },
      );
      return promise;
    },
  };
  observeProofMethod(target, 'sync', 'helper-forget-record', records);
  assert.equal(target.sync(token), result);
  observeProofMethod(target, 'stop', 'project-stop', records, {
    role: () => 'helper',
    after() {
      throw new Error('canary-private');
    },
  });
  const abort = new AbortController();
  const actual = target.stop(abort.signal);
  assert.equal(actual, promise);
  assert.equal(records[1].result, 'started');
  abort.abort();
  assert.equal(await actual, result);
  assert.equal(called, 2);
  assert.equal(cancelled, 1);
  assert.equal(records[1].result, 'completed');
  assert.equal(records[1].snapshotUnavailable, true);
  assert.equal(records[1].role, 'helper');
  assert.ok(!JSON.stringify(records).includes('canary-private'));
});
test('cleanup observations preserve original failure and closed-fence refusal without raw errors or retries', async () => {
  for (const error of [
    new Error('LIVE_SETTLEMENT_REQUIRED'),
    new Error('canary-private-raw-error'),
    null,
    {
      get message() {
        throw new Error('canary-private-getter');
      },
    },
  ]) {
    const records = [];
    let calls = 0;
    const original = Promise.reject(error);
    original.catch(() => {});
    const target = {
      drain() {
        calls++;
        return original;
      },
    };
    observeProofMethod(target, 'drain', 'poll-drain', records);
    assert.equal(target.drain(), original);
    await assert.rejects(original, (e) => e === error);
    assert.equal(calls, 1);
    assert.equal(records[0].result, 'failed');
    assert.equal(
      records[0].failure,
      error instanceof Error && error.message === 'LIVE_SETTLEMENT_REQUIRED'
        ? 'LIVE_SETTLEMENT_REQUIRED'
        : 'UNCLASSIFIED',
    );
    assert.ok(!JSON.stringify(records).includes('canary-private'));
  }
  const records = [];
  const target = {
    stop() {
      throw Object.assign(new Error('LIVE_HELPER_COMMAND_AMBIGUOUS'), {
        stage: 'native-command-exit',
        stdout: 'canary-private',
      });
    },
  };
  observeProofMethod(target, 'stop', 'project-stop', records);
  assert.throws(() => target.stop(), /LIVE_HELPER_COMMAND_AMBIGUOUS/);
  assert.equal(records[0].failureStage, 'native-command-exit');
  assert.ok(!JSON.stringify(records).includes('canary-private'));
});
test('cleanup observations are bounded and lifecycle snapshots cannot expose identity or change durable recovery state', () => {
  const records = [],
    target = {
      stop() {
        return 1;
      },
    };
  observeProofMethod(target, 'stop', 'project-stop', records);
  for (let i = 0; i < 80; i++) target.stop();
  assert.equal(records.length, 64);
  assert.equal(records.at(-1).truncatedBefore, true);
  const run = {
    state: 'recoveryRequired',
    phase: 'ready',
    generation: 2,
    controllerEpoch: 1,
    rootThreadId: 'canary-private-thread',
  };
  const g = {
    run: { liveId: 'canary-private-id', controllerEpoch: 1 },
    session: { threadId: 'canary-private-thread' },
    plannedGeneration: 1,
    retired: true,
    helper: {
      diagnostics: () => ({
        namespaceExited: true,
        pipeDescriptorsClosed: false,
        path: 'canary-private',
      }),
    },
  };
  const controller = {
    generations: new Map([['canary-private', g]]),
    owners: { current: () => run },
  };
  const value = cleanupControllerSnapshot(controller);
  assert.equal(value.generations[0].generation, 2);
  assert.equal(value.generations[0].plannedGeneration, 1);
  assert.equal(value.generations[0].sameRootThread, true);
  assert.equal(value.generations[0].children[0].namespaceExited, true);
  assert.equal(run.state, 'recoveryRequired');
  assert.ok(!JSON.stringify(value).includes('canary-private'));
  assert.equal(
    cleanupControllerSnapshot({
      generations: {
        get values() {
          throw new Error('canary-private');
        },
      },
    }).available,
    false,
  );
});

test('cleanup admission refusals retain only fixed reason codes across nested causes', () => {
  for (const reason of ['stale-controller', 'canary-private-reason']) {
    const records = [];
    const error = Object.assign(new Error('LIVE_ADMISSION_UNAVAILABLE'), {
      cause: { diagnostic: { reason, raw: 'canary-private-token' } },
    });
    const target = {
      revoke() {
        throw error;
      },
    };
    observeProofMethod(target, 'revoke', 'signed-revoke', records);
    assert.throws(
      () => target.revoke(),
      (value) => value === error,
    );
    assert.equal(records[0].failure, 'LIVE_ADMISSION_UNAVAILABLE');
    assert.equal(records[0].admissionReason, reason === 'stale-controller' ? reason : undefined);
    assert.ok(!JSON.stringify(records).includes('canary-private'));
  }
});

test('policy phase observations preserve serial calls, exact promises and six local validations without logging inputs', async () => {
  const order = [],
    secret = 'canary-private-argument';
  const installation = {
    manager: { path: 'manager' },
    node: { path: 'node' },
    packages: [{ name: 'gestalt', root: 'package' }],
  };
  class Policy {
    installation = installation;
    verifyInstallation() {
      order.push('local');
    }
    async command(binary, args) {
      assert.equal(args.at(-1), secret);
      order.push(binary === 'manager' ? 'manager' : 'agents');
      await new Promise((done) => setTimeout(done, 5));
      this.verifyInstallation();
      return { secret };
    }
    async observeOriginalSources() {
      this.verifyInstallation();
      order.push('observer');
      await new Promise((done) => setTimeout(done, 5));
      this.verifyInstallation();
      return { secret };
    }
    verify() {
      this.actual = (async () => {
        this.verifyInstallation();
        await this.command('manager', ['live-policy', 'verify', '--manifest', secret]);
        await this.observeOriginalSources(secret);
        await this.command('node', [
          'package/scripts/live-admission.mjs',
          'verify',
          '--bootstrap',
          secret,
        ]);
        this.verifyInstallation();
        return { secret };
      })();
      return this.actual;
    }
  }
  const report = observeInstalledPolicyTimings(Policy.prototype),
    owner = new Policy();
  const actual = owner.verify(secret);
  assert.equal(actual, owner.actual);
  assert.deepEqual(await actual, { secret });
  assert.deepEqual(order, [
    'local',
    'manager',
    'local',
    'local',
    'observer',
    'local',
    'agents',
    'local',
    'local',
  ]);
  assert.equal(report.counters['policy-local-installation'].started, 6);
  for (const label of [
    'policy-total',
    'policy-manager-verify',
    'policy-source-observer',
    'policy-agents-verify',
  ])
    assert.equal(report.counters[label].completed, 1);
  assert.ok(report.calls.every((call) => call.groupId === 1));
  assert.ok(!JSON.stringify(report).includes(secret));
  const before = report.calls.length;
  await owner.command('manager', ['live-policy', 'seal-runtime', '--manifest', secret]);
  assert.equal(
    report.calls.slice(before).some((call) => call.operation === 'policy-manager-verify'),
    false,
  );
});
test('policy phase timing drains only original work and preserves refusal without dispatching later phases', async () => {
  const error = new Error('LIVE_ADMISSION_UNAVAILABLE');
  let managerCalls = 0,
    observerCalls = 0,
    agentCalls = 0;
  class Policy {
    installation = { manager: { path: 'manager' }, node: { path: 'node' }, packages: [] };
    verifyInstallation() {}
    command(binary) {
      if (binary === 'manager') {
        managerCalls++;
        return Promise.reject(error);
      }
      agentCalls++;
      return Promise.resolve();
    }
    observeOriginalSources() {
      observerCalls++;
      return Promise.resolve();
    }
    verify() {
      this.actual = (async () => {
        await this.command('manager', ['live-policy', 'verify', '--manifest', 'canary-private']);
        await this.observeOriginalSources();
        return this.command('node', []);
      })();
      return this.actual;
    }
  }
  const report = observeInstalledPolicyTimings(Policy.prototype),
    owner = new Policy();
  const actual = owner.verify();
  assert.equal(actual, owner.actual);
  await assert.rejects(actual, (value) => value === error);
  assert.equal(managerCalls, 1);
  assert.equal(observerCalls, 0);
  assert.equal(agentCalls, 0);
  assert.equal(report.counters['policy-total'].failed, 1);
  assert.equal(report.counters['policy-manager-verify'].failed, 1);
  assert.ok(!JSON.stringify(report).includes('canary-private'));
});

test('concurrent independent verification observations correlate groups without sharing readiness or results', async () => {
  class Policy {
    installation = { manager: { path: 'manager' }, node: { path: 'node' }, packages: [] };
    verifyInstallation() {}
    async command() {
      await new Promise((done) => setTimeout(done, 5));
      return this.value;
    }
    observeOriginalSources() {
      return Promise.resolve(this.value);
    }
    verify() {
      this.actual = this.command('manager', ['live-policy', 'verify', '--manifest', 'private']);
      return this.actual;
    }
  }
  const report = observeInstalledPolicyTimings(Policy.prototype);
  const a = new Policy(),
    b = new Policy();
  a.value = 1;
  b.value = 2;
  const pa = a.verify(),
    pb = b.verify();
  assert.equal(pa, a.actual);
  assert.equal(pb, b.actual);
  assert.deepEqual(await Promise.all([pa, pb]), [1, 2]);
  for (const group of [1, 2])
    assert.deepEqual(
      report.calls.filter((row) => row.groupId === group).map((row) => row.operation),
      ['policy-total', 'policy-manager-verify'],
    );
  b.value = 3;
  assert.equal(await b.verify(), 3);
  assert.equal(report.counters['policy-total'].completed, 3);
});

test('admission observations retain original RPC promises, arguments, receiver, serial order and fixed labels', async () => {
  const calls = [],
    secret = 'private-canary',
    expected = {};
  let lastPromise;
  const rpc = {
    request(method, params) {
      assert.equal(this, rpc);
      calls.push([method, params]);
      lastPromise = Promise.resolve(expected);
      return lastPromise;
    },
  };
  const params = [
    ['mcpServerStatus/list', { threadId: secret, serverName: 'context-mode', detail: 'full' }],
    ['mcpServerStatus/list', { threadId: secret, serverName: 'gestalt-org-plan', detail: 'full' }],
    ['config/read', { includeLayers: true, cwd: secret }],
    ['thread/read', { threadId: secret, includeTurns: false }],
    ['account/read', { refreshToken: false }],
  ];
  const runtime = {
    inspectLiveAdmission(arg) {
      assert.equal(this, runtime);
      assert.equal(arg, expected);
      return (async () => {
        for (const [method, input] of params) {
          const result = rpc.request(method, input);
          assert.equal(result, lastPromise);
          assert.equal(await result, expected);
        }
        return expected;
      })();
    },
  };
  const controller = {
    verifyProjectResources(arg) {
      assert.equal(arg, expected);
      return expected;
    },
  };
  const timing = observeAdmissionTimings(runtime, controller);
  timing.observeRpc(rpc);
  assert.equal(await runtime.inspectLiveAdmission(expected), expected);
  assert.equal(controller.verifyProjectResources(expected), expected);
  assert.deepEqual(calls, params);
  assert.deepEqual(
    timing.report.calls.map((v) => v.operation),
    [
      'admission-inspection',
      'admission-catalog-context',
      'admission-catalog-org',
      'admission-config',
      'admission-thread',
      'admission-account',
      'admission-resources',
    ],
  );
  assert.ok(
    timing.report.calls.slice(0, 6).every((v) => v.groupId === 1 && v.result === 'completed'),
  );
  assert.equal(timing.report.calls.at(-1).groupId, 0);
  assert.equal(timing.report.counters['admission-catalog-context'].started, 1);
  assert.equal(timing.report.counters['admission-catalog-org'].completed, 1);
  assert.ok(!JSON.stringify(timing.report).includes(secret));
});

test('admission observations preserve rejected promises and sync errors without retaining payloads or matching broad catalogs', async () => {
  const error = new Error('private-canary');
  const pending = Promise.reject(error);
  const rpc = {
    request() {
      return pending;
    },
  };
  const runtime = {
    inspectLiveAdmission() {
      return pending;
    },
  };
  const controller = {
    verifyProjectResources() {
      throw error;
    },
  };
  const timing = observeAdmissionTimings(runtime, controller);
  timing.observeRpc(rpc);
  assert.equal(runtime.inspectLiveAdmission(), pending);
  assert.equal(rpc.request('mcpServerStatus/list', { threadId: 'private-canary' }), pending);
  assert.equal(timing.report.calls.length, 1);
  assert.equal(
    rpc.request('mcpServerStatus/list', {
      threadId: 'private-canary',
      serverName: 'context-mode',
      detail: 'full',
    }),
    pending,
  );
  await assert.rejects(pending, (value) => value === error);
  assert.throws(
    () => controller.verifyProjectResources(),
    (value) => value === error,
  );
  assert.ok(
    timing.report.calls.every((v) => v.result === 'failed' && v.failure === 'UNCLASSIFIED'),
  );
  assert.ok(!JSON.stringify(timing.report).includes('private-canary'));
});

test('admission timing bounds pending observations and keeps overlapping inspection groups distinct', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const rpc = {
    request() {
      return pending;
    },
  };
  const runtime = {
    inspectLiveAdmission() {
      return rpc.request('account/read', { refreshToken: false });
    },
  };
  const controller = { verifyProjectResources() {} };
  const timing = observeAdmissionTimings(runtime, controller);
  timing.observeRpc(rpc);
  for (let n = 0; n < 260; n++) assert.equal(runtime.inspectLiveAdmission(), pending);
  assert.equal(timing.report.calls.length, 512);
  assert.ok(timing.report.calls.some((v) => v.truncatedBefore));
  assert.equal(new Set(timing.report.calls.map((v) => v.groupId)).size, 256);
  finish();
  await pending;
  assert.ok(timing.report.calls.every((v) => v.result === 'completed'));
  assert.equal(timing.report.counters['admission-inspection'].started, 260);
  assert.equal(timing.report.counters['admission-account'].completed, 260);
});

test('post-Accept acknowledgement observation is allowlisted and follows acknowledgement without reordering Steer', () => {
  const script = readFileSync(
    new URL('./live-production-edit-browser.mjs', import.meta.url),
    'utf8',
  );
  const immediate = script.indexOf("await observePicker('after-accept')");
  const acknowledgement = script.indexOf("await command('accepted', acceptDeadline)", immediate);
  const afterAck = script.indexOf("await observePicker('after-accept-ack')", acknowledgement);
  const steer = script.indexOf("await observePicker('before-steer')", afterAck);
  assert.ok(
    immediate > 0 && acknowledgement > immediate && afterAck > acknowledgement && steer > afterAck,
  );
  assert.equal(
    boundedPickerObservation({ boundary: 'after-accept-ack', available: false }).boundary,
    'after-accept-ack',
  );
});

test('authority diagnostics preserve actual success and exact rejection with fixed closure boundaries and redaction', async () => {
  let closure = 'open',
    calls = 0,
    callbackCalls = 0;
  const records = [],
    sentinel = new Error('private https://credential.test/secret bearer-canary');
  let reject;
  const target = {
    async liveEvent(fence, event, work) {
      calls++;
      assert.equal(fence, 'exact-fence');
      if (event === 'poll')
        return await new Promise((_, r) => {
          reject = r;
        });
      return await work();
    },
  };
  observeEventAuthority(target, records, () => closure);
  assert.equal(
    await target.liveEvent('exact-fence', 'abcdef12', async () => {
      callbackCalls++;
      return 'exact-result';
    }),
    'exact-result',
  );
  const pending = target.liveEvent('exact-fence', 'poll', async () => {
    callbackCalls++;
  });
  closure = 'closing';
  reject(sentinel);
  await assert.rejects(pending, (error) => error === sentinel);
  assert.equal(calls, 2);
  assert.equal(callbackCalls, 1);
  assert.equal(records[0].completed, true);
  assert.equal(records[0].phase, 'event-turn');
  assert.equal(records[1].completed, false);
  assert.equal(records[1].phase, 'canonical-poll');
  assert.equal(records[1].grantedAfterMs, null);
  assert.equal(records[1].closureAtStart, 'open');
  assert.equal(records[1].closureAtFinish, 'closing');
  assert.equal(records[1].failure, 'UNCLASSIFIED');
  assert.ok(!JSON.stringify(records).includes('credential'));
  assert.ok(!JSON.stringify(records).includes('bearer-canary'));
});
test('authority diagnostic instrumentation handles failed work, hostile errors, unavailable boundaries and bounded rows', async () => {
  const records = [];
  const error = {
    get message() {
      throw new Error('private-canary');
    },
  };
  const target = {
    liveEvent(_f, _e, work) {
      return work();
    },
  };
  observeEventAuthority(target, records, () => {
    throw new Error('private-boundary');
  });
  await assert.rejects(
    target.liveEvent(null, 'abcdef12', () => Promise.reject(error)),
    (v) => v === error,
  );
  assert.equal(records[0].completed, false);
  assert.ok(Number.isSafeInteger(records[0].grantedAfterMs) && records[0].grantedAfterMs >= 0);
  assert.equal(records[0].failure, 'UNCLASSIFIED');
  assert.equal(records[0].closureAtFinish, 'unavailable');
  for (let i = 0; i < 66; i++) await target.liveEvent(null, 'poll', () => i);
  assert.equal(records.length, 64);
  assert.ok(records.every((v) => v.completed));
  assert.ok(!JSON.stringify(records).includes('private'));
  const fixed = [];
  const rejected = {
    liveEvent() {
      throw new Error('LIVE_GENERATION_STALE');
    },
  };
  observeEventAuthority(rejected, fixed, () => 'private-boundary');
  await assert.rejects(
    rejected.liveEvent(null, 'poll', () => {}),
    /LIVE_GENERATION_STALE/,
  );
  assert.equal(fixed[0].failure, 'LIVE_GENERATION_STALE');
  assert.equal(fixed[0].closureAtStart, 'unavailable');
});

test('continuity observation binds actual current-document SSE and visible chrome/heading, refusing stale flags', () => {
  const dom = new JSDOM(
    '<h1 class="hero-title">Production chosen variant</h1><div id="impeccable-live-global-bar"></div><div id="impeccable-live-page-chat"></div>',
    { runScripts: 'outside-only' },
  );
  const w = dom.window;
  const probe = w.eval('(' + pickerContinuityProbe.toString() + ')');
  Object.defineProperty(w.document, 'readyState', { value: 'complete', configurable: true });
  for (const node of w.document.querySelectorAll('h1,div'))
    node.getBoundingClientRect = () => ({ width: 100, height: 30 });
  w.__productionHelperConnected = true;
  w.__productionHelperConnectedDocument = w.performance.timeOrigin;
  const args = { heading: 'Production chosen variant' };
  assert.equal(probe(args).documentBirth, w.performance.timeOrigin);
  w.__productionHelperConnectedDocument -= 1;
  assert.equal(probe(args), false);
  w.__productionHelperConnectedDocument = w.performance.timeOrigin;
  assert.equal(probe({ ...args, documentBirth: w.performance.timeOrigin - 1 }), false);
  w.document.querySelector('#impeccable-live-page-chat').style.display = 'none';
  assert.equal(probe(args), false);
  w.document.querySelector('#impeccable-live-page-chat').style.display = '';
  w.document.querySelector('h1').textContent = 'wrong';
  assert.equal(probe(args), false);
  w.document.querySelector('h1').textContent = args.heading;
  Object.defineProperty(w.document, 'readyState', { value: 'loading' });
  assert.equal(probe(args), false);
  dom.window.close();
});
test('continuity retries changed document only under original remaining deadline and performs no actions', async () => {
  let now = 10,
    reads = 0,
    disposed = 0;
  const seen = [];
  const page = {
    async waitForFunction(_fn, _args, options) {
      seen.push(options.timeout);
      now += 10;
      const birth = ++reads;
      return {
        async jsonValue() {
          return { documentBirth: birth };
        },
        async dispose() {
          disposed++;
        },
      };
    },
    async evaluate(_fn, args) {
      now += 10;
      return reads === 1 ? false : { documentBirth: args.documentBirth };
    },
  };
  const result = await observePickerContinuity(page, {
    deadline: 100,
    heading: 'chosen',
    now: () => now,
  });
  assert.equal(result.freshDocumentHelperConnected, true);
  assert.deepEqual(seen, [90, 70]);
  assert.equal(disposed, 2);
  const expired = {
    async waitForFunction() {
      now = 100;
      return {
        async jsonValue() {
          throw new Error('must not read after expiry');
        },
        async dispose() {},
      };
    },
  };
  now = 99;
  await assert.rejects(
    observePickerContinuity(expired, { deadline: 100, heading: 'chosen', now: () => now }),
    /PROOF_OBSERVATION_DEADLINE/,
  );
  assert.throws(() => proofObservationRemaining(100, 100), /PROOF_OBSERVATION_DEADLINE/);
  assert.throws(() => proofObservationRemaining(300001, 0), /PROOF_OBSERVATION_DEADLINE/);
  let lateWork;
  await assert.rejects(
    withinProofObservation(
      () =>
        new Promise((resolve) => {
          lateWork = resolve;
        }),
      Date.now() + 10,
    ),
    /PROOF_OBSERVATION_DEADLINE/,
  );
  lateWork('late nonauthorizing read');
});

test('manual observation sees one original post-authority IPC dispatch and current owned birth, not callback alone', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.stdin.on('data',()=>process.stdout.write('dispatched\\n'));"],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const birth = processBirth(child.pid);
  let sent = 0,
    resolveCommand,
    mutateDuringBirth = false,
    birthAllowed = true;
  const receipt = {
    sessionId: 'session',
    generation: 1,
    role: 'helper',
    owner: birth,
    relay: birth,
    target: birth,
  };
  class Process {
    commands = new Map();
    receipt = receipt;
    revoked = false;
    send() {
      sent++;
      child.stdin.write('poll');
    }
    helperCommand(_receipt, args) {
      const result = new Promise((resolve) => {
        resolveCommand = resolve;
      });
      this.commands.set(7, {});
      this.send({ op: 'helper-command', requestId: 7, args });
      return result;
    }
  }
  const sample = observeCanonicalPollDispatch(Process.prototype, (b) => {
    assert.equal(birthCurrent(b), true);
    if (mutateDuringBirth) run = { ...run, generation: 2 };
    return birthAllowed;
  });
  const ownedProcess = new Process();
  let run = { state: 'active', relayId: 'session', generation: 1 };
  const guard = {
    input: {
      owners: {
        assert() {
          return run;
        },
      },
    },
    async liveEvent(_f, _e, work) {
      return work();
    },
  };
  observeEventAuthority(guard, [], () => 'open');
  let flight;
  try {
    assert.equal(sample('session', 1), null);
    const dispatched = new Promise((resolve) => child.stdout.once('data', resolve));
    flight = guard.liveEvent({ generation: 1 }, 'poll-token', () =>
      ownedProcess.helperCommand(receipt, ['live-poll', '--timeout=600000']),
    );
    await dispatched;
    const observed = sample('session', 1);
    assert.equal(observed.commandIpcDispatched, true);
    assert.equal(observed.pending, true);
    assert.equal(observed.foregroundChildBirthObserved, false);
    assert.equal(sent, 1);
    assert.equal(sample('session', 2), null);
    run = { ...run, generation: 2 };
    assert.equal(sample('session', 1), null);
    run = { ...run, generation: 1 };
    mutateDuringBirth = true;
    assert.equal(sample('session', 1), null);
    mutateDuringBirth = false;
    run = { ...run, generation: 1 };
    birthAllowed = false;
    assert.equal(sample('session', 1), null);
    birthAllowed = true;
    ownedProcess.revoked = true;
    assert.equal(sample('session', 1), null);
    ownedProcess.revoked = false;
    const entry = ownedProcess.commands.get(7);
    ownedProcess.commands.set(7, {});
    assert.equal(sample('session', 1), null);
    ownedProcess.commands.set(7, entry);
    ownedProcess.commands.delete(7);
    assert.equal(sample('session', 1), null);
    resolveCommand('actual-result');
    await flight;
    assert.equal(sample('session', 1), null);
    assert.equal(sent, 1);
  } finally {
    resolveCommand?.();
    await flight;
    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
  }
  assert.equal(birthCurrent(birth), false);
  assert.equal(sample('session', 1), null);
});
test('canonical poll callback without a real worker dispatch never releases observation', async () => {
  const prototype = {
    helperCommand() {
      return Promise.resolve('no dispatch');
    },
    send() {
      throw new Error('must not send');
    },
  };
  const sample = observeCanonicalPollDispatch(prototype, () => {
    throw new Error('no positive birth');
  });
  const guard = {
    async liveEvent(_f, _id, work) {
      return work();
    },
  };
  observeEventAuthority(guard, [], () => 'open');
  await guard.liveEvent({}, 'poll-token', () =>
    prototype.helperCommand({ sessionId: 's', generation: 1 }, ['live-poll', '--timeout=600000']),
  );
  assert.equal(sample('s', 1), null);
});
test('manual observations reserve original event/host/lease composition and reject insufficient remaining budget', () => {
  assert.equal(
    manualObservationDeadline({ startedAt: 1000, hostDeadline: 901000, now: 1000 }),
    116000,
  );
  assert.equal(
    manualObservationDeadline({ startedAt: 1000, hostDeadline: 550000, now: 1000 }),
    70000,
  );
  assert.throws(
    () => manualObservationDeadline({ startedAt: 1000, hostDeadline: 480001, now: 1000 }),
    /PROOF_OBSERVATION_DEADLINE/,
  );
  assert.throws(
    () => manualObservationDeadline({ startedAt: 1000, hostDeadline: 901000, now: 116000 }),
    /PROOF_OBSERVATION_DEADLINE/,
  );
});
test('manual conservative enqueue bound requires exact real entry/event and durable ack correlation within original lease', () => {
  const sample = {
    requestStartedAt: 1000,
    acceptedAt: 1100,
    acknowledgedAt: 101000,
    entryDigest: 'a'.repeat(64),
    correlation: { entryDigest: 'a'.repeat(64), eventDigest: 'b'.repeat(64) },
    canonical: {
      eventDigest: 'b'.repeat(64),
      kind: 'manual_edit_apply',
      stage: 'acknowledged',
      history: ['received', 'dispatched', 'applied', 'acknowledged'],
      leaseUntil: 600000,
    },
  };
  const result = verifyManualAcknowledgement(sample);
  assert.equal(result.enqueueToAckUpperBoundMs, 100000);
  assert.equal(result.requestStartToAcceptedMs, 100);
  for (const mutate of [
    (s) => (s.entryDigest = 'c'.repeat(64)),
    (s) => (s.correlation.eventDigest = 'c'.repeat(64)),
    (s) => (s.canonical.kind = 'generate'),
    (s) => (s.canonical.stage = 'applied'),
    (s) => s.canonical.history.pop(),
    (s) => (s.acknowledgedAt = 121001),
    (s) => (s.acceptedAt = 999),
    (s) => (s.canonical.leaseUntil = s.acknowledgedAt),
    (s) => (s.requestStartedAt = NaN),
  ]) {
    const current = structuredClone(sample);
    mutate(current);
    assert.throws(() => verifyManualAcknowledgement(current), /PROOF_MANUAL_ACK_INVALID/);
  }
});

test('manual failure timing retains only observed timestamps and real202 with no inferred missing historical values', () => {
  const request = {
    boundary: 'commit-requested',
    requestStartedAt: 1000,
    deadline: 121000,
    entryDigest: 'a'.repeat(64),
    private: 'canary-private',
    status: undefined,
  };
  const first = boundedManualCommitObservation(request);
  assert.equal(first.acceptedAt, null);
  assert.equal(first.status, null);
  assert.equal(first.deadline, 121000);
  const accepted = boundedManualCommitObservation({
    ...request,
    boundary: 'commit-response',
    acceptedAt: 1100,
    status: 202,
  });
  assert.equal(accepted.requestStartedAt, 1000);
  assert.equal(accepted.acceptedAt, 1100);
  assert.equal(accepted.status, 202);
  const final = boundedManualCommitObservation({ ...request, boundary: 'browser-finally' });
  assert.equal(final.acceptedAt, null);
  assert.equal(final.deadline, 121000);
  assert.ok(!JSON.stringify(first).includes('canary'));
  assert.equal(boundedManualCommitObservation({ boundary: 'private-canary' }), null);
  const invalid = boundedManualCommitObservation({
    boundary: 'browser-finally',
    requestStartedAt: NaN,
    acceptedAt: -1,
    entryDigest: 'raw-private-id',
    status: 900,
  });
  assert.deepEqual(invalid, {
    boundary: 'browser-finally',
    requestStartedAt: null,
    acceptedAt: null,
    deadline: null,
    status: null,
    entryDigest: null,
  });
});
test('manual acknowledgement failure emits before and finally history with exact original error and no false ack', async () => {
  const records = [],
    state = {
      generation: 1,
      entryDigest: 'a'.repeat(64),
      events: [
        {
          stage: 'dispatched',
          history: ['received', 'dispatched'],
          eventDigest: 'b'.repeat(64),
          secret: 'private-canary',
        },
      ],
    };
  const sentinel = new Error('credential-canary');
  let calls = 0;
  await assert.rejects(
    observeManualAcknowledgement(
      async () => {
        calls++;
        assert.equal(records[0].boundary, 'before-ack');
        throw sentinel;
      },
      records,
      () => state,
    ),
    (e) => e === sentinel,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    records.map((v) => v.boundary),
    ['before-ack', 'ack-failed'],
  );
  assert.deepEqual(records[1].events[0].history, ['received', 'dispatched']);
  state.events[0].history.push('applied');
  assert.deepEqual(records[1].events[0].history, ['received', 'dispatched']);
  assert.ok(!JSON.stringify(records).includes('canary'));
  const result = await observeManualAcknowledgement(
    async () => {
      state.events[0].stage = 'acknowledged';
      state.events[0].history = ['received', 'dispatched', 'applied', 'acknowledged'];
      return 'actual-result';
    },
    records,
    () => state,
  );
  assert.equal(result, 'actual-result');
  assert.equal(records.at(-1).boundary, 'ack-completed');
  assert.equal(records.at(-1).events[0].stage, 'acknowledged');
});
test('manual failure and preclose retention stay bounded and cannot replace failure when canonical snapshot unavailable', async () => {
  const rows = [];
  const error = new Error('original-error');
  const unavailable = () => {
    throw new Error('private-path-canary');
  };
  await assert.rejects(
    observeManualAcknowledgement(() => Promise.reject(error), rows, unavailable),
    (e) => e === error,
  );
  assert.deepEqual(rows, [
    { boundary: 'before-ack', available: false },
    { boundary: 'ack-failed', available: false },
  ]);
  for (let i = 0; i < 20; i++)
    retainManualCanonicalObservation(
      rows,
      i % 2 ? 'production-failure' : 'before-close',
      unavailable,
    );
  assert.equal(rows.length, 16);
  assert.ok(rows.every((v) => v.available === false));
  assert.ok(!JSON.stringify(rows).includes('canary'));
});
test('actual browser emits bracket before canonical ack and in finally while preserving original120s deadline', () => {
  const script = readFileSync(
    new URL('./live-production-edit-browser.mjs', import.meta.url),
    'utf8',
  );
  const requested = script.indexOf("emitManualCommitObservation('commit-requested')"),
    response = script.indexOf("emitManualCommitObservation('commit-response')");
  const beforeAck = script.indexOf("emitManualCommitObservation('before-canonical-ack')"),
    ack = script.indexOf("await command('manual-applied'", beforeAck),
    final = script.lastIndexOf("emitManualCommitObservation('browser-finally')"),
    close = script.indexOf('await browser?.close()', final);
  assert.ok(
    requested > 0 &&
      response > requested &&
      beforeAck > response &&
      ack > beforeAck &&
      final > ack &&
      close > final,
  );
  assert.equal((script.match(/manualCommitDeadline = manualDeadline/g) || []).length, 1);
});

test('startup failure classification retains only fixed timeout/refusal/closed/protocol vocabulary', () => {
  const records = [];
  for (const code of [
    'LIVE_NATIVE_HANDOFF_UNVERIFIED',
    'LIVE_NATIVE_HANDOFF_TIMEOUT',
    'LIVE_NATIVE_HANDOFF_CWD_UNVERIFIED',
    'CODEX_STARTUP_DISCOVERY_TIMEOUT',
    'CODEX_STARTUP_CANCELLED',
    'CODEX_RPC_TRANSPORT_CLOSED',
    'CODEX_RPC_INPUT_FAILED',
    'CODEX_RPC_OUTPUT_FAILED',
    'LIVE_ADMISSION_UNAVAILABLE',
  ]) {
    const row = retainOwningStartupFailure(
      records,
      'captured-initialize',
      new Error(code),
      12.4,
      true,
    );
    assert.equal(row.code, code);
    assert.equal(row.elapsedMs, 12);
    assert.equal(row.childAlive, true);
  }
  const unknown = retainOwningStartupFailure(
    records,
    'captured-initialize',
    { message: 'private-token-canary', code: '/private/path' },
    NaN,
    'alive',
    { phase: 'manager-command', reason: 'private-secret-canary' },
  );
  assert.equal(unknown.code, 'UNCLASSIFIED');
  assert.equal(unknown.elapsedMs, null);
  assert.equal(unknown.childAlive, null);
  assert.equal(unknown.admission.reason, 'unclassified-refusal');
  assert.equal(
    retainOwningStartupFailure(
      records,
      'captured-initialize',
      { kind: 'CODEX_JSON_RPC_ERROR', message: 'raw-result-canary' },
      0,
      false,
    ).code,
    'CODEX_JSON_RPC_ERROR',
  );
  assert.equal(
    retainOwningStartupFailure(records, 'captured-initialize', null, -1, null).code,
    'UNCLASSIFIED',
  );
  assert.equal(
    retainOwningStartupFailure(records, 'private-canary', new Error('secret'), 1, true),
    undefined,
  );
  assert.ok(!JSON.stringify(records).includes('canary'));
  for (let i = 0; i < 20; i++)
    retainOwningStartupFailure(records, 'owning-admission-rejection', {}, 1, null);
  assert.equal(records.length, 16);
});
test('startup observer preserves one dispatch and exact success/error with first failure before cleanup', async () => {
  const failure = new Error('CODEX_STARTUP_DISCOVERY_TIMEOUT'),
    cleanup = new Error('LIVE_CLEANUP_REQUIRED');
  let dispatched = 0;
  const events = [],
    errors = [];
  const work = async () => {
    dispatched++;
    throw failure;
  };
  const run = async (session, original) => {
    assert.equal(session, 'exact-session');
    try {
      return await original();
    } catch (error) {
      assert.equal(error, failure);
      events.push('cleanup');
      throw cleanup;
    }
  };
  await assert.rejects(
    observeOwningAdmissionFailure(run, 'exact-session', work, (boundary, error) => {
      events.push(boundary);
      errors.push(error);
    }),
    (error) => error === cleanup,
  );
  assert.equal(dispatched, 1);
  assert.deepEqual(errors, [failure, cleanup]);
  assert.deepEqual(events, ['owning-admission-work', 'cleanup', 'owning-admission-rejection']);
  await assert.rejects(
    observeOwningStartupFailure(work, (error) => assert.equal(error, failure)),
    (error) => error === failure,
  );
  await assert.rejects(
    observeOwningStartupFailure(work, () => {
      throw new Error('observer-canary');
    }),
    (error) => error === failure,
  );
  const result = { unchanged: true };
  assert.equal(
    await observeOwningAdmissionFailure(
      (_session, original) => original(),
      'exact-session',
      () => result,
      () => assert.fail('success is not failure'),
    ),
    result,
  );
});
test('actual startup proof observes capture and first RPC error through the original admission port', () => {
  const source = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(source.includes("'captureRuntime'"));
  assert.ok(source.includes("'captured-initialize'"));
  assert.ok(source.includes('return originalStartupDiscovery.apply(this, args)'));
});

test('independent owning launch uses authenticated cwd and current runtime image gate before exactly one controlled RPC', async () => {
  const { capturedNativeImageFence } =
    await import('../dist/server/server/platform/codex/codex-process-launcher.js');
  const { CodexSessionRuntime } =
    await import('../dist/server/server/platform/codex/session-runtime.js');
  const { JsonRpcClient } = await import('../dist/server/server/platform/codex/json-rpc-client.js');
  const { dirname } = await import('node:path');
  const { realpathSync, existsSync } = await import('node:fs');
  const source = readFileSync(new URL('./live-model-tools-proof.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function launchIndependentOwner(');
  assert.ok(start >= 0);
  const seam = source.slice(start, source.indexOf('\n}\n', start) + 3);
  const executable = realpathSync(process.execPath);
  const sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const root = mkdtempSync(join(tmpdir(), 'l11-independent-launch-'));
  const final = join(root, 'owner'),
    wrong = join(root, 'wrong');
  mkdirSync(final);
  mkdirSync(wrong);
  try {
    for (const variant of ['authenticated', 'missing', 'wrong']) {
      const report = {};
      let launches = 0,
        observations = 0,
        owned;
      const requestLog = join(root, variant + '.rpc');
      const code = `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(requestLog)},q.method+'\\n');process.stdout.write(JSON.stringify({id:q.id,result:{ok:true}})+'\\n');});`;
      const args = ['-e', code];
      const capture = { manifestPath: join(final, 'manifest.json'), captureId: 'exact-capture' };
      const policy = {
        owningRuntimeCwd(manifest, id) {
          observations++;
          assert.equal(manifest, capture.manifestPath);
          assert.equal(id, capture.captureId);
          return final;
        },
      };
      const launcher = (input, trusted) => {
        launches++;
        assert.deepEqual(trusted.managedLaunch.cwdTransition, { intermediate: final, final });
        const began = performance.now();
        const child = spawn(
          '/usr/bin/bash',
          [
            '--noprofile',
            '--norc',
            '-c',
            'cd -- "$1"; shift; exec "$@"',
            'wrapper',
            final,
            executable,
            ...args,
          ],
          { cwd: input.cwd, env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' },
        );
        const closed = new Promise((resolve) => child.once('close', resolve));
        const descriptor =
          variant === 'missing'
            ? { intermediate: '', final: '' }
            : variant === 'wrong'
              ? { intermediate: final, final: wrong }
              : trusted.managedLaunch.cwdTransition;
        owned = {
          child,
          closed,
          rpc: new JsonRpcClient(child.stdout, child.stdin),
          waitForLiveImage: capturedNativeImageFence(
            child,
            { executable, sha256, args, cwd: input.cwd, cwdTransition: descriptor },
            began,
          ),
        };
        return owned;
      };
      const launch = new Function(
        'launchCodexAppServer',
        'binary',
        'LIVE_CODEX_SHA256',
        'dirname',
        'performance',
        `${seam}\nreturn launchIndependentOwner;`,
      )(launcher, executable, sha256, dirname, performance);
      const processOwner = launch(
        { cwd: root, liveCaptureId: capture.captureId },
        capture,
        policy,
        { installation: { manager: { path: '/fixed-manager' } } },
        {},
        report,
      );
      const runtime = Object.create(CodexSessionRuntime.prototype);
      runtime.admissionResources = new Set();
      const resource = {
        liveCaptureId: capture.captureId,
        active: true,
        process: processOwner,
        lifetime: new AbortController(),
        admissionRequests: new Set(),
      };
      try {
        assert.equal(existsSync(requestLog), false);
        if (variant === 'authenticated') {
          await runtime.awaitCapturedImage(resource);
          assert.equal(existsSync(requestLog), false);
          assert.deepEqual(await runtime.startupRequest(resource, 'initialize', {}), { ok: true });
          assert.equal(readFileSync(requestLog, 'utf8'), 'initialize\n');
          assert.equal(report.nativeImage.outcome, 'completed');
        } else {
          await assert.rejects(
            runtime.awaitCapturedImage(resource),
            /LIVE_NATIVE_HANDOFF_UNVERIFIED/,
          );
          assert.equal(existsSync(requestLog), false);
          assert.equal(report.nativeImage.outcome, 'failed');
          assert.ok(['construction', 'cwd'].includes(report.nativeImage.phase));
        }
        assert.equal(launches, 1);
        assert.equal(observations, 1);
        assert.ok(!JSON.stringify(report).includes(root));
      } finally {
        owned.child.kill('SIGTERM');
        await owned.closed;
        assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null);
        assert.equal(resource.admissionRequests.size, 0);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('independent image observer preserves first error identity and cleanup keeps bounded revoke failure separate', async () => {
  const { InstalledLiveAdmissionError } =
    await import('../dist/server/server/platform/live-design/installed-policy.js');
  const source = readFileSync(new URL('./live-model-tools-proof.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function launchIndependentOwner(');
  const seam = source.slice(start, source.indexOf('\n}\n', start) + 3);
  const invalidAuthority = new Error('LIVE_NATIVE_HANDOFF_CWD_UNVERIFIED');
  let unauthenticatedLaunches = 0;
  const forbiddenLaunch = new Function(
    'launchCodexAppServer',
    'binary',
    'LIVE_CODEX_SHA256',
    'dirname',
    'performance',
    `${seam}\nreturn launchIndependentOwner;`,
  )(
    () => {
      unauthenticatedLaunches++;
    },
    '/fixed-native',
    'fixed-digest',
    () => '/fixed-dir',
    performance,
  );
  assert.throws(
    () =>
      forbiddenLaunch(
        {},
        { manifestPath: '/fixed', captureId: 'capture' },
        {
          owningRuntimeCwd() {
            throw invalidAuthority;
          },
        },
        { installation: { manager: { path: '/fixed-manager' } } },
        {},
        {},
      ),
    (error) => error === invalidAuthority,
  );
  assert.equal(unauthenticatedLaunches, 0);
  const first = Object.assign(new Error('LIVE_NATIVE_HANDOFF_UNVERIFIED'), {
    handoffPhase: 'cwd',
    privateCanary: 'secret-value',
  });
  const owner = {
    async waitForLiveImage() {
      throw first;
    },
  };
  const launch = new Function(
    'launchCodexAppServer',
    'binary',
    'LIVE_CODEX_SHA256',
    'dirname',
    'performance',
    `${seam}\nreturn launchIndependentOwner;`,
  )(
    () => owner,
    '/fixed-native',
    'fixed-digest',
    () => '/fixed-dir',
    performance,
  );
  const report = { failure: { code: first.message } };
  launch(
    {},
    { manifestPath: '/fixed-dir/manifest', captureId: 'capture' },
    { owningRuntimeCwd: () => '/fixed-dir' },
    { installation: { manager: { path: '/fixed-manager' } } },
    {},
    report,
  );
  await assert.rejects(
    owner.waitForLiveImage(new AbortController().signal),
    (error) => error === first,
  );
  assert.equal(report.nativeImage.code, first.message);
  assert.equal(report.nativeImage.phase, 'cwd');
  const cleanupStart = source.indexOf(
    '  if (capture && !captureRevoked) {',
    source.indexOf('} finally {\n  report.cleanupStage'),
  );
  const cleanup = source.slice(
    cleanupStart,
    source.indexOf("  report.cleanupStage = 'runtime-stop';", cleanupStart),
  );
  const run = new Function(
    'capture',
    'captureRevoked',
    'policy',
    'report',
    'InstalledLiveAdmissionError',
    'performance',
    `return (async()=>{${cleanup};return captureRevoked;})();`,
  );
  for (const error of [
    Object.assign(new Error('secret-value'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('secret-value'), {
      stdout: JSON.stringify({
        schemaVersion: 2,
        available: false,
        liveReady: false,
        reason: 'invalid-capture',
      }),
    }),
    Object.assign(new Error('secret-value'), { stdout: 'malformed secret-value' }),
  ]) {
    let calls = 0;
    const copy = structuredClone(report);
    const revoked = await run(
      { manifestPath: '/fixed', captureId: 'capture' },
      false,
      {
        async revokeRuntime() {
          calls++;
          throw error;
        },
      },
      copy,
      InstalledLiveAdmissionError,
      performance,
    );
    assert.equal(revoked, false);
    assert.equal(calls, 1);
    assert.equal(copy.cleanupFailure, 'NATIVE_CAPTURE_REVOCATION_UNVERIFIED');
    assert.equal(copy.cleanupRevoke.outcome, 'failed');
    assert.deepEqual(copy.failure, report.failure);
    assert.equal(copy.nativeImage.code, first.message);
    assert.ok(!JSON.stringify(copy).includes('secret-value'));
    assert.equal(copy.cleanupComplete, undefined);
  }
});

test('only exact manual lane selects owning edit-only work; other modes retain confinement', () => {
  assert.equal(productionModelWorkload('manual-discard'), 'owning-edit-only');
  for (const lane of ['', 'accept-steer', 'recovery'])
    assert.equal(productionModelWorkload(lane), 'owning-edit-and-confinement');
  assert.throws(() => productionModelWorkload('manual'));
  const source = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  const identity = source.indexOf('assert.equal(metadata.session_id, owningNativeSession)');
  const child = source.indexOf("assert.equal(role, 'root', 'MANUAL_UNEXPECTED_CHILD')");
  const routing = source.indexOf(
    "(productionModelWorkload(proofLane) === 'owning-edit-only' || step >= 7)",
  );
  assert.ok(identity > 0 && child > identity && routing > child);
  assert.ok(source.slice(identity, routing).includes('liveEventFromRequest(body)'));
  assert.ok(!source.includes('roles.set(role, 7)'));
});

test('actual entrypoint manual routing validates owning identity and performs one real patch/readback without probes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'l11-manual-entrypoint-'));
  try {
    const source = readFileSync(
      new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
      'utf8',
    );
    const begin = source.indexOf('async function eventFor(body) {');
    const end = source.indexOf('\nconst provider = createServer', begin);
    assert.ok(begin > 0 && end > begin);
    const manual = {
      type: 'manual_edit_apply',
      id: 'event',
      batch: { entries: [{ id: 'entry', ops: [{ newText: 'Production manual approved' }] }] },
    };
    const create = () => {
      const report = { provider: {} };
      const emitted = [];
      const planner = createProductionEditProvider(root, final, report, { lane: 'manual-discard' });
      const factory = new Function(
        'assert',
        'productionModelWorkload',
        'liveEventFromRequest',
        'planner',
        'report',
        'emitted',
        `
        const proofLane='manual-discard', seed=false, editFlow=true;
        const serialProfile=undefined;
        const owningThread='thread',owningNativeSession='session';
        let firstPickerEventId,firstPickerObservationStarted,contextCompletion,childThread;
        const roles=new Map();
        const hash=value=>value;
        const toolsIn=tools=>tools;
        const call=(tool,id,args)=>{emitted.push(tool.name);return {name:tool.name,args};};
        const editResponse=planner;
        ${source.slice(begin, end)}
        return eventFor;
      `,
      );
      return {
        report,
        emitted,
        event: factory(
          assert,
          productionModelWorkload,
          liveEventFromRequest,
          planner,
          report,
          emitted,
        ),
      };
    };
    const request = (event = manual) => ({
      ...body(event),
      model: 'gpt-6-sol',
      reasoning: { effort: 'medium' },
      client_metadata: { thread_id: 'thread', session_id: 'session' },
      tools: [{ name: 'apply_patch', type: 'custom' }],
    });
    writeFileSync(join(root, 'index.html'), '<h1>Owning app</h1>\n');
    const f = create();
    const patch = await f.event(request());
    assert.deepEqual(f.emitted, ['apply_patch']);
    simulatePatch(root, patch);
    const result = await f.event(request());
    assert.equal(result.status, 'done');
    assert.deepEqual(result.appliedEntryIds, undefined);
    assert.deepEqual(result.data.appliedEntryIds, ['entry']);
    assert.deepEqual(f.emitted, ['apply_patch']);
    assert.equal(f.report.modelWorkload, 'owning-edit-only');
    assert.equal(f.report.provider.contextProtocol, undefined);
    for (const mutate of [
      (r) => {
        r.client_metadata.thread_id = 'other';
      },
      (r) => {
        r.client_metadata.session_id = 'other';
      },
      (r) => {
        r.model = 'other';
      },
      (r) => {
        r.reasoning.effort = 'low';
      },
      (r) => {
        r.tools = [];
      },
    ]) {
      writeFileSync(join(root, 'index.html'), '<h1>Owning app</h1>\n');
      const bad = create(),
        r = request();
      mutate(r);
      await assert.rejects(() => bad.event(r));
      assert.deepEqual(bad.emitted, []);
    }
    writeFileSync(join(root, 'index.html'), '<h1>Owning app</h1>\n');
    const changed = create();
    simulatePatch(root, await changed.event(request()));
    writeFileSync(join(root, 'index.html'), '<h1>unexpected mutation</h1>\n');
    await assert.rejects(() => changed.event(request()));
    assert.deepEqual(changed.emitted, ['apply_patch']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failure Stop uses one exact fresh durable owner, joins real settlement and verifies restoration before cleanup', async () => {
  const initial = {
    run: {
      liveId: 'live',
      relayId: 'session',
      rootThreadId: 'thread',
      controllerEpoch: 'controller',
      targetIdentity: 'target',
      app: { device: '1', inode: '2' },
      generation: 1,
      state: 'active',
    },
    captureId: 'capture',
  };
  let current = structuredClone(initial),
    calls = 0;
  current.run.generation = 2;
  current.run.state = 'recoveryRequired';
  const evidence = [];
  const attempt = failureStopOperation({
    expected: initial,
    read: () => structuredClone(current),
    deadline: Date.now() + 1000,
    evidence: (r) => evidence.push(r),
    stop: async (fence) => {
      calls++;
      assert.deepEqual(fence, { liveId: 'live', generation: 2 });
      current.run = { ...current.run, generation: 3, state: 'idle', controlsRestored: true };
      return { state: 'idle' };
    },
    verify: async () => {
      assert.equal(current.run.state, 'idle');
    },
  });
  const operation = attempt();
  assert.equal(attempt(), operation);
  await operation.drain;
  assert.equal(calls, 1);
  assert.equal(operation.observed.drained, true);
  assert.equal(operation.observed.verified, true);
  assert.equal(evidence.at(-1).pending, false);
});
test('failure Stop refuses stale/mutated owners, captures and app identity before dispatch', async () => {
  const expected = {
    run: {
      liveId: 'live',
      relayId: 'session',
      rootThreadId: 'thread',
      controllerEpoch: 'controller',
      targetIdentity: 'target',
      app: { device: '1', inode: '2' },
      generation: 1,
      state: 'active',
    },
    captureId: 'capture',
  };
  for (const mutate of [
    ...['liveId', 'relayId', 'rootThreadId', 'controllerEpoch', 'targetIdentity'].map(
      (k) => (v) => {
        v.run[k] = 'other';
      },
    ),
    (v) => {
      v.run.generation = 0;
    },
    (v) => {
      v.captureId = 'other';
    },
    (v) => {
      v.run.app.inode = 'other';
    },
    (v) => {
      v.run.state = 'stopping';
    },
  ]) {
    let calls = 0;
    const value = structuredClone(expected);
    mutate(value);
    const operation = failureStopOperation({
      expected,
      read: () => value,
      deadline: Date.now() + 1000,
      evidence: () => {},
      stop: async () => {
        calls++;
      },
      verify: async () => {},
    })();
    await assert.rejects(() => operation.drain);
    assert.equal(calls, 0);
    assert.equal(operation.observed.verified, false);
  }
});
test('expired failure Stop never dispatches and an in-flight expiry is not cancellation or drain', async () => {
  const expected = {
    run: {
      liveId: 'live',
      relayId: 'session',
      rootThreadId: 'thread',
      controllerEpoch: 'controller',
      targetIdentity: 'target',
      app: { device: '1', inode: '2' },
      generation: 1,
      state: 'active',
    },
    captureId: 'capture',
  };
  let calls = 0;
  const expired = failureStopOperation({
    expected,
    read: () => expected,
    deadline: Date.now() - 1,
    evidence: () => {},
    stop: async () => {
      calls++;
    },
    verify: async () => {},
  })();
  await assert.rejects(() => expired.drain);
  assert.equal(calls, 0);
  let release;
  const pending = new Promise((r) => (release = r));
  let current = structuredClone(expected);
  const evidence = [];
  const attempt = failureStopOperation({
    expected,
    read: () => structuredClone(current),
    deadline: Date.now() + 15,
    evidence: (r) => evidence.push(r),
    stop: async () => {
      calls++;
      await pending;
      current.run.state = 'idle';
      current.run.controlsRestored = true;
      return { state: 'idle' };
    },
    verify: async () => {
      assert.fail('late Stop cannot verify');
    },
  });
  const operation = attempt();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(operation.observed.pending, true);
  assert.equal(operation.observed.drained, false);
  assert.equal(operation.observed.deadlineExceeded, true);
  assert.equal(evidence.at(-1).pending, true);
  release();
  await assert.rejects(() => operation.drain, /PROOF_FAILURE_STOP_DEADLINE/);
  assert.equal(operation.observed.drained, true);
  assert.equal(operation.observed.verified, false);
  assert.equal(calls, 1);
  assert.equal(attempt(), operation);
});
test('failed or mutated late Stop/closure cannot replace original editing failure or claim cleanup', async () => {
  const expected = {
    run: {
      liveId: 'live',
      relayId: 'session',
      rootThreadId: 'thread',
      controllerEpoch: 'controller',
      targetIdentity: 'target',
      app: { device: '1', inode: '2' },
      generation: 1,
      state: 'active',
    },
    captureId: 'capture',
  };
  for (const kind of ['refusal', 'drain-timeout', 'wrong-result', 'closure', 'mutation']) {
    const first = Error('ORIGINAL_EDIT_FAILURE');
    const report = { failure: first };
    let current = structuredClone(expected),
      calls = 0;
    const op = failureStopOperation({
      expected,
      read: () => structuredClone(current),
      deadline: Date.now() + 1000,
      evidence: (r) => {
        report.failureStop = r;
      },
      stop: async () => {
        calls++;
        if (kind === 'refusal' || kind === 'drain-timeout') throw Error('STOP_REFUSED');
        current.run.state = 'idle';
        current.run.controlsRestored = true;
        return { state: kind === 'wrong-result' ? 'active' : 'idle' };
      },
      verify: async () => {
        if (kind === 'closure') throw Error('CLOSURE_UNVERIFIED');
        if (kind === 'mutation') current.captureId = 'other';
      },
    })();
    await assert.rejects(() => op.drain);
    assert.equal(report.failure, first);
    assert.equal(op.observed.verified, false);
    assert.equal(calls, 1);
  }
});
test('failure cleanup static source expectation matches actual pinned helper removal without erasing edits', () => {
  const helper = process.env.LIVE_TEST_IMPECCABLE;
  const root = mkdtempSync(join(tmpdir(), 'l11-cleanup-source-'));
  try {
    mkdirSync(join(root, '.impeccable/live'), { recursive: true });
    writeFileSync(
      join(root, '.impeccable/live/config.json'),
      JSON.stringify({ files: ['index.html'], insertBefore: '</body>', commentSyntax: 'html' }),
    );
    writeFileSync(
      join(root, 'index.html'),
      '<html>\n<body>\n<h1>Edited app</h1>\n</body>\n</html>\n',
    );
    execFileSync(
      helper,
      ['live-inject', '--port', '8412', '--token', 'disposable-test-only', '--target', root],
      { cwd: root, stdio: 'pipe' },
    );
    const expected = withoutProofInjection(readFileSync(join(root, 'index.html'), 'utf8'));
    assert.ok(expected.includes('Edited app'));
    execFileSync(helper, ['live-inject', '--remove', '--target', root], {
      cwd: root,
      stdio: 'pipe',
    });
    assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), expected);
    assert.throws(() => withoutProofInjection('<!-- impeccable-live-start -->unterminated'));
    assert.throws(() => withoutProofInjection('<meta data-impeccable-csp-original="x">'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('editing clock propagates immutable absolute offsets and refuses late dispatch without resetting on navigation', () => {
  const anchor = { monotonicNs: '1000000000' };
  const at = (ms) => 1000000000n + BigInt(ms) * 1000000n;
  assert.equal(editingSchedule.job, 2700000);
  assert.equal(editingRemaining(anchor, 'setup', at(63520)), 56480);
  assert.equal(editingRemaining(anchor, 'accepted', at(120000)), 1260000);
  assert.equal(editingRemaining(anchor, 'action', at(1380000)), 1020000);
  assert.equal(requireEditingBudget(anchor, 'action', 1020000, at(1380000)), 1020000);
  assert.throws(() => requireEditingBudget(anchor, 'action', 1020000, at(1380001)), /INSUFFICIENT/);
  assert.equal(editingRemaining(anchor, 'action', at(2400000)), 0);
  assert.equal(editingRemaining(anchor, 'cleanup', at(2400000)), 180000);
  assert.equal(editingRemaining(anchor, 'artifacts', at(2580000)), 60000);
  assert.throws(() => editingRemaining(anchor, 'action', 1n), /CLOCK_INVALID/);
  assert.throws(
    () => editingRemaining({ monotonicNs: 'secret' }, 'action', at(0)),
    /CLOCK_INVALID/,
  );
  assert.throws(() => editingRemaining(anchor, 'reset', at(0)), /CLOCK_INVALID/);
  assert.throws(() => requireEditingBudget(anchor, 'setup', 1, at(120001)), /INSUFFICIENT/);
});
test('editing failure persists unresolved lock before joining actual operation; queued Stop is not cancellation', async () => {
  for (const reject of [false, true]) {
    let settle,
      rows = [],
      stopCalls = 0,
      completed = false;
    const pending = new Promise((resolve, failure) => {
      settle = reject ? failure : resolve;
    });
    const drain = drainEditingFailure({
      pending,
      record: (row) => rows.push(row),
      stop: async () => {
        stopCalls++;
      },
    });
    drain.then(() => {
      completed = true;
    });
    await new Promise((done) => setTimeout(done, 15));
    assert.deepEqual(rows, [{ operationPending: true, cleanupPending: true, lockRetained: true }]);
    assert.equal(completed, false);
    assert.equal(stopCalls, 0);
    settle(new Error('private-token-must-not-be-retained'));
    await drain;
    assert.equal(stopCalls, 1);
    assert.equal(JSON.stringify(rows).includes('private-token'), false);
  }
});

test('resumed Steer uses BOTH current-cookie expiries; short sliding expiry cannot borrow a long absolute or peer lease', () => {
  const now = 1000000;
  const lease = {
    generation: 3,
    leaseExpiresAt: new Date(now + 300000).toISOString(),
    absoluteExpiresAt: new Date(now + 3600000).toISOString(),
  };
  assert.equal(editingLeaseCapacity(lease, 3, now), true);
  for (const mutate of [
    (v) => {
      v.generation = 2;
    },
    (v) => {
      v.leaseExpiresAt = new Date(now + 1000).toISOString();
    },
    (v) => {
      v.leaseExpiresAt = new Date(now + 194999).toISOString();
    },
    (v) => {
      v.absoluteExpiresAt = new Date(now + 194999).toISOString();
    },
    (v) => {
      v.absoluteExpiresAt = 'invalid';
    },
    (v) => {
      v.leaseExpiresAt = 'invalid';
    },
  ]) {
    const value = structuredClone(lease);
    mutate(value);
    assert.equal(editingLeaseCapacity(value, 3, now), false);
  }
  assert.equal(
    editingLeaseCapacity({ state: 'active', generation: 3, leases: [lease] }, 3, now),
    false,
  );
});
test('actual Steer observation path reads fresh cookie lease AFTER continuity and clamps sliding absolute and host deadlines before submit', async () => {
  for (const [sliding, absolute, host] of [
    [250000, 350000, 400000],
    [350000, 250000, 400000],
    [350000, 350000, 250000],
  ]) {
    let now = 1000000,
      reads = 0,
      submits = 0;
    const trace = [];
    const deadline = await observeEditingSteer({
      generation: 3,
      hostDeadline: now + host,
      now: () => now,
      observeContinuity: async () => {
        trace.push('continuity');
        now += 30000;
      },
      readLease: async () => {
        trace.push('current-cookie');
        reads++;
        return {
          generation: 3,
          leaseExpiresAt: new Date(1000000 + sliding).toISOString(),
          absoluteExpiresAt: new Date(1000000 + absolute).toISOString(),
        };
      },
      submit: (value) => {
        trace.push('submitSteer');
        submits++;
        return value;
      },
    });
    assert.deepEqual(trace, ['continuity', 'current-cookie', 'submitSteer']);
    assert.equal(reads, 1);
    assert.equal(submits, 1);
    assert.equal(deadline, 1000000 + Math.min(sliding, absolute, host) - 15000);
  }
});
test('fresh post-continuity expiry or failed cookie observation refuses actual submit with no renewal retry', async () => {
  for (const kind of [
    'one-second-sliding',
    'continuity-used-capacity',
    'stale-generation',
    'missing-cookie',
    'read-failure',
    'host-expiry',
  ]) {
    let now = 1000000,
      reads = 0,
      submits = 0;
    const until = now + 300000;
    await assert.rejects(
      observeEditingSteer({
        generation: 3,
        hostDeadline: kind === 'host-expiry' ? now + 200000 : now + 400000,
        now: () => now,
        observeContinuity: async () => {
          now += kind === 'continuity-used-capacity' ? 120000 : 30000;
        },
        readLease: async () => {
          reads++;
          if (kind === 'read-failure') throw new Error('COOKIE_OBSERVATION_FAILED');
          if (kind === 'missing-cookie') return null;
          return {
            generation: kind === 'stale-generation' ? 2 : 3,
            leaseExpiresAt: new Date(
              kind === 'one-second-sliding' ? now + 1000 : until,
            ).toISOString(),
            absoluteExpiresAt: new Date(until + 3600000).toISOString(),
          };
        },
        submit: () => {
          submits++;
        },
      }),
      /PROOF_EDIT_(LEASE_INSUFFICIENT|BUDGET_INSUFFICIENT)|COOKIE_OBSERVATION_FAILED/,
    );
    assert.equal(reads, 1);
    assert.equal(submits, 0);
  }
});
test('old cookie proof requires exact supported401 LIVE_AUTH_REQUIRED, never infrastructure failure or malformed response', () => {
  assertOldPreviewCookieDenied({
    status: 401,
    body: JSON.stringify({ code: 'LIVE_AUTH_REQUIRED' }),
  });
  for (const response of [
    undefined,
    { status: 500, body: 'private transport error' },
    { status: 503, body: JSON.stringify({ code: 'LIVE_AUTH_REQUIRED' }) },
    { status: 200, body: JSON.stringify({ code: 'LIVE_AUTH_REQUIRED' }) },
    { status: 401, body: 'not-json' },
    { status: 401, body: JSON.stringify({ code: 'AUTH_REQUIRED' }) },
    { status: 401, body: JSON.stringify({ error: 'LIVE_AUTH_REQUIRED' }) },
  ])
    assert.throws(
      () => assertOldPreviewCookieDenied(response),
      (error) => error.message === 'PROOF_OLD_COOKIE_NOT_DENIED',
    );
});

function previewExchangeFixture() {
  const verifier = 'v'.repeat(43);
  const request = {
    liveId: 'live-id',
    generation: 3,
    codeChallengeMethod: 'S256',
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  };
  const grant = {
    previewOrigin: 'https://preview.test',
    grantId: 'grant-id',
    grant: 'g'.repeat(43),
  };
  const exchange = { grantId: grant.grantId, grant: grant.grant, codeVerifier: verifier };
  const calls = { grantBodies: 0, exchangeBodies: 0 };
  const phases = [];
  const response = (body, status, url, json) => ({
    request: () => ({ method: () => 'POST', postDataJSON: () => body }),
    status: () => status,
    url: () => url,
    json,
  });
  const options = {
    liveId: request.liveId,
    generation: request.generation,
    previewOrigin: grant.previewOrigin,
    deadline: Date.now() + 1000,
    checkpoint: (phase) => phases.push(phase),
    grantResponse: Promise.resolve(
      response(
        request,
        201,
        'https://mobile.test/api/sessions/session/live/launch-grants',
        async () => {
          calls.grantBodies++;
          return grant;
        },
      ),
    ),
    exchangeResponse: Promise.resolve(
      response(exchange, 201, grant.previewOrigin + '/__gestalt_live/exchange', () => {
        calls.exchangeBodies++;
        return new Promise(() => {});
      }),
    ),
  };
  return { options, request, grant, exchange, calls, phases };
}
test('preview binds the real authenticated grant and exact exchange without consuming the retiring navigation body', async () => {
  const f = previewExchangeFixture();
  assert.deepEqual(await observePreviewExchange(f.options), { liveId: 'live-id', generation: 3 });
  assert.deepEqual(f.calls, { grantBodies: 1, exchangeBodies: 0 });
  assert.deepEqual(f.phases, [
    'preview-grant-response',
    'preview-grant-body',
    'preview-exchange-response',
  ]);
});
test('preview rejects stale/wrong grant identity, exchange identity, proof and origin without replay', async () => {
  for (const mutate of [
    (f) => {
      f.request.liveId = 'wrong';
    },
    (f) => {
      f.request.generation--;
    },
    (f) => {
      f.request.codeChallengeMethod = 'plain';
    },
    (f) => {
      f.request.codeChallenge = 'wrong';
    },
    (f) => {
      f.grant.previewOrigin = 'https://other.test';
    },
    (f) => {
      f.exchange.grantId = 'other';
    },
    (f) => {
      f.exchange.grant = 'other';
    },
    (f) => {
      f.exchange.codeVerifier = 'x'.repeat(43);
    },
    (f) => {
      f.options.exchangeResponse = Promise.resolve({
        request: () => ({ method: () => 'POST', postDataJSON: () => f.exchange }),
        status: () => 500,
        url: () => 'https://preview.test/__gestalt_live/exchange',
      });
    },
    (f) => {
      f.options.exchangeResponse = Promise.resolve({
        request: () => ({ method: () => 'POST', postDataJSON: () => f.exchange }),
        status: () => 201,
        url: () => 'https://other.test/__gestalt_live/exchange',
      });
    },
  ]) {
    const f = previewExchangeFixture();
    mutate(f);
    await assert.rejects(observePreviewExchange(f.options), /PROOF_PREVIEW_IDENTITY_INVALID/);
    assert.equal(f.calls.exchangeBodies, 0);
    assert.ok(f.calls.grantBodies <= 1);
  }
});
test('pending stable grant body or response expires at the original deadline and records the precise awaited phase', async () => {
  for (const phase of ['response', 'body', 'exchange']) {
    const f = previewExchangeFixture();
    f.options.deadline = Date.now() + 25;
    const pending = new Promise(() => {});
    if (phase === 'response') f.options.grantResponse = pending;
    if (phase === 'body') (await f.options.grantResponse).json = () => pending;
    if (phase === 'exchange') f.options.exchangeResponse = pending;
    await assert.rejects(observePreviewExchange(f.options), /PROOF_OBSERVATION_DEADLINE/);
    assert.equal(
      f.phases.at(-1),
      phase === 'body'
        ? 'preview-grant-body'
        : phase === 'response'
          ? 'preview-grant-response'
          : 'preview-exchange-response',
    );
    assert.equal(f.calls.exchangeBodies, 0);
  }
});

test('actual proof Stop verification preserves the live restored Native until actual Mobile close verifies its exit exactly once', async () => {
  const source = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  const stopStart = source.indexOf('failureCleanupStop = () =>');
  const verifyStart =
    source.indexOf('verify: async () => {', stopStart) + 'verify: async () => {'.length;
  const verifyBody = source.slice(
    verifyStart,
    source.indexOf('\n          },\n        })();', verifyStart),
  );
  const closeStart = source.indexOf('async function closeMobileOnce() {');
  const closeBody = source.slice(closeStart, source.indexOf('\nlet probeTimer;', closeStart));
  let alive = true,
    closes = 0;
  const observedBirthExited = () => !alive;
  const contents = new Map([
    ['/home/config.toml', 'original'],
    ['/app/index.html', 'accepted'],
    ['/app/app.js', 'module'],
  ]);
  const verify = new Function(
    'assert',
    'signed',
    'join',
    'controller',
    'hash',
    'appRoot',
    'readOwner',
    'projectProcesses',
    'readFileSync',
    'owningHome',
    'installedOriginalConfig',
    'expectedIndex',
    'expectedModule',
    'existsSync',
    'observedBirthExited',
    'baselineBirth',
    'return async () => {' + verifyBody + '}',
  )(
    assert,
    () => ({ status: 'revoked' }),
    join,
    '/controller',
    (v) => String(v),
    '/app',
    () => ({ run: { state: 'idle', controlsRestored: true } }),
    new Map([
      [{ diagnostics: () => ({ namespaceExited: true, pipeDescriptorsClosed: true }) }, true],
    ]),
    (path) => contents.get(path),
    '/home',
    'original',
    'accepted',
    'module',
    () => false,
    observedBirthExited,
    {},
  );
  await verify();
  assert.equal(alive, true);
  const makeClose = (mobile) =>
    new Function(
      'assert',
      'mobile',
      'baselineBirth',
      'observedBirthExited',
      'let mobileClose; ' + closeBody + '; return closeMobileOnce;',
    )(assert, mobile, {}, observedBirthExited);
  const close = makeClose({
    close: async () => {
      closes++;
      alive = false;
    },
  });
  await close();
  await close();
  assert.equal(closes, 1);
  assert.equal(observedBirthExited(), true);
  alive = true;
  await assert.rejects(makeClose({ close: async () => {} })(), { code: 'ERR_ASSERTION' });
  await assert.rejects(
    makeClose({
      close: async () => {
        throw new Error('CLOSE_FAILED');
      },
    })(),
    /CLOSE_FAILED/,
  );
  contents.set('/home/config.toml', 'not-restored');
  await assert.rejects(verify(), { code: 'ERR_ASSERTION' });
});

test('post-Accept dispatch observation holds the browser during pending authority and releases only exact existing IPC evidence before original cutoff', async () => {
  let now = 1000,
    reads = 0,
    ready = false;
  const evidence = {
    sequence: 8,
    commandIpcDispatched: true,
    workerBirthsCurrent: true,
    postAuthority: true,
    pending: true,
    generationMatches: true,
    foregroundChildBirthObserved: false,
  };
  const result = await observePostAcceptPollDispatch({
    deadline: 121000,
    now: () => now,
    sample: () => {
      reads++;
      return ready ? evidence : null;
    },
    pause: async () => {
      now += 117168;
      ready = true;
    },
  });
  assert.equal(result, evidence);
  assert.equal(reads, 2);
  assert.equal(now, 118168);
});
test('post-Accept readiness refuses pre-authority, settled, wrong-generation/birth and fabricated-child evidence', async () => {
  const valid = {
    sequence: 8,
    commandIpcDispatched: true,
    workerBirthsCurrent: true,
    postAuthority: true,
    pending: true,
    generationMatches: true,
    foregroundChildBirthObserved: false,
  };
  for (const changed of [
    { sequence: 0 },
    { commandIpcDispatched: false },
    { workerBirthsCurrent: false },
    { postAuthority: false },
    { pending: false },
    { generationMatches: false },
    { foregroundChildBirthObserved: true },
  ]) {
    await assert.rejects(
      observePostAcceptPollDispatch({
        sample: () => ({ ...valid, ...changed }),
        deadline: 2000,
        now: () => 1000,
      }),
      /PROOF_POST_ACCEPT_POLL_INVALID/,
    );
  }
});
test('post-Accept readiness never resets expired A or accepts a read finishing after its original cutoff', async () => {
  for (const kind of ['authority-never-dispatched', 'read-crossed-cutoff', 'already-expired']) {
    let now = kind === 'already-expired' ? 2000 : 1000,
      reads = 0;
    await assert.rejects(
      observePostAcceptPollDispatch({
        deadline: 2000,
        now: () => now,
        sample: () => {
          reads++;
          if (kind === 'read-crossed-cutoff') now = 2000;
          return null;
        },
        pause: async () => {
          now = 2000;
        },
      }),
      /PROOF_OBSERVATION_DEADLINE/,
    );
    assert.equal(reads, kind === 'already-expired' ? 0 : 1);
  }
});

test('manual cookie observation binds actual host/port/Secure/HttpOnly/expiry and exposes no bearer', () => {
  const now = Date.now(),
    token = 'a'.repeat(43);
  const cookie = {
    name: '__Host-gestalt_live_p9443',
    domain: 'preview.test',
    path: '/',
    secure: true,
    httpOnly: true,
    value: token,
    expires: (now + 150_000) / 1000,
  };
  const actual = previewCookieObservation([cookie], 'https://preview.test:9443', now);
  assert.equal(actual.tokenDigest, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(actual).includes(token));
  for (const change of [
    { domain: 'peer.test' },
    { name: '__Host-gestalt_live_p9444' },
    { path: '/peer' },
    { secure: false },
    { httpOnly: false },
    { value: 'bad' },
    { expires: now / 1000 },
    { expires: -1 },
  ])
    assert.throws(
      () => previewCookieObservation([{ ...cookie, ...change }], 'https://preview.test:9443', now),
      /PROOF_MANUAL_COOKIE_INVALID/,
    );
  assert.throws(() => previewCookieObservation([cookie, cookie], 'https://preview.test:9443', now));
});

test('private lease correlation rejects every wrong audience field and peer token, not merely first listed lease', () => {
  const now = Date.now(),
    audience = {
      relayId: 'relay',
      appId: 'app',
      liveId: 'live',
      generation: 3,
      previewOrigin: 'https://preview.test:9443',
      authSessionHash: 'auth',
      deviceId: 'device',
    };
  const cookie = {
    tokenDigest: 'a'.repeat(64),
    cookieExpiresAt: new Date(now + 100_000).toISOString(),
  };
  const lease = {
    ...audience,
    tokenHash: cookie.tokenDigest,
    leaseExpiresAt: new Date(now + 100_000).toISOString(),
    absoluteExpiresAt: new Date(now + 600_000).toISOString(),
  };
  assertPreviewLeaseIdentity(lease, cookie, audience, now);
  for (const field of Object.keys(audience))
    assert.throws(
      () =>
        assertPreviewLeaseIdentity(
          { ...lease, [field]: field === 'generation' ? 2 : 'peer' },
          cookie,
          audience,
          now,
        ),
      /PROOF_MANUAL_LEASE_IDENTITY/,
    );
  for (const change of [
    { tokenHash: 'b'.repeat(64) },
    { leaseExpiresAt: new Date(now).toISOString() },
    { absoluteExpiresAt: 'invalid' },
  ])
    assert.throws(() => assertPreviewLeaseIdentity({ ...lease, ...change }, cookie, audience, now));
  assert.throws(() => assertPreviewLeaseIdentity(null, cookie, audience, now));
});

function manualRenewalFixture() {
  let clock = Date.now();
  const start = clock;
  const cookie = {
    tokenDigest: 'a'.repeat(64),
    cookieExpiresAt: new Date(start + 160_000).toISOString(),
  };
  const lease = {
    generation: 1,
    stage: 'before-generate',
    renewed: true,
    tokenDigest: cookie.tokenDigest,
    leaseExpiresAt: new Date(start + 300_000).toISOString(),
    absoluteExpiresAt: new Date(start + 3_000_000).toISOString(),
    priorAbsoluteExpiresAt: new Date(start + 3_000_000).toISOString(),
  };
  const current = { ...cookie, cookieExpiresAt: lease.leaseExpiresAt };
  const calls = [];
  const options = {
    cookie,
    generation: 1,
    hostDeadline: start + 800_000,
    now: () => clock,
    renew: async (observed) => {
      assert.equal(observed, cookie);
      calls.push('owner-renew');
      return lease;
    },
    redeliver: async () => {
      calls.push('same-cookie-redelivery');
      return lease;
    },
    readCookie: async () => {
      calls.push('actual-browser-cookie');
      return current;
    },
  };
  return {
    options,
    cookie,
    lease,
    current,
    calls,
    start,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('manual renewal observes one owner operation then same-token redelivery and actual cookie before Generate', async () => {
  const f = manualRenewalFixture();
  const actual = await renewManualPreviewLease(f.options);
  assert.equal(actual.cookie, f.current);
  assert.deepEqual(f.calls, ['owner-renew', 'same-cookie-redelivery', 'actual-browser-cookie']);
  assert.equal(manualLeaseEstimate.generate, 87_260 + 79_394 + 30_000);
  assert.equal(manualLeaseEstimate.discard, 74_270 + 87_260 + 30_000);
  const deadline = manualLeaseDeadline({
    ...actual,
    generation: 1,
    hostDeadline: f.start + 800_000,
    requiredMs: manualLeaseEstimate.generate,
    now: f.start,
  });
  assert.equal(deadline, f.start + 285_000); //300s TTL, existing15s safety reserve.
  assert.equal(deadline - f.start - manualLeaseEstimate.generate, 88_346);
});

test('manual renewal never substitutes a grant, peer cookie, generation, absolute cap or hoped-for expiry', async () => {
  for (const kind of [
    'generation',
    'owner-token',
    'absolute',
    'redelivery-expiry',
    'peer-cookie',
    'no-redelivery',
    'cookie-after-server',
    'ttl-widened',
    'absolute-capacity',
  ]) {
    const f = manualRenewalFixture();
    if (kind === 'generation') f.lease.generation = 2;
    if (kind === 'owner-token') f.lease.tokenDigest = 'b'.repeat(64);
    if (kind === 'absolute')
      f.lease.absoluteExpiresAt = new Date(f.start + 3_100_000).toISOString();
    if (kind === 'redelivery-expiry')
      f.options.redeliver = async () => ({
        ...f.lease,
        leaseExpiresAt: new Date(f.start + 299_000).toISOString(),
      });
    if (kind === 'peer-cookie') f.current.tokenDigest = 'b'.repeat(64);
    if (kind === 'no-redelivery') f.current.cookieExpiresAt = f.cookie.cookieExpiresAt;
    if (kind === 'cookie-after-server')
      f.current.cookieExpiresAt = new Date(f.start + 302_000).toISOString();
    if (kind === 'ttl-widened') {
      f.lease.leaseExpiresAt = new Date(f.start + 301_000).toISOString();
      f.current.cookieExpiresAt = f.lease.leaseExpiresAt;
    }
    if (kind === 'absolute-capacity') {
      f.lease.absoluteExpiresAt = f.lease.priorAbsoluteExpiresAt = new Date(
        f.start + 60_000,
      ).toISOString();
    }
    await assert.rejects(
      renewManualPreviewLease(f.options),
      /PROOF_MANUAL_LEASE_(IDENTITY|INSUFFICIENT)/,
      kind,
    );
    assert.equal(f.calls.filter((v) => v === 'owner-renew').length, 1);
  }
});

test('manual renewal refusal and original deadline crossing cannot retry or proceed to edit dispatch', async () => {
  for (const kind of [
    'owner-refusal',
    'redelivery-refusal',
    'before',
    'owner-race',
    'cookie-race',
  ]) {
    const f = manualRenewalFixture();
    if (kind === 'owner-refusal')
      f.options.renew = async () => {
        f.calls.push('owner-renew');
        throw Error('REFUSED');
      };
    if (kind === 'redelivery-refusal')
      f.options.redeliver = async () => {
        throw Error('REFUSED');
      };
    if (kind === 'before') f.options.hostDeadline = f.start;
    if (kind === 'owner-race')
      f.options.renew = async () => {
        f.calls.push('owner-renew');
        f.advance(30_000);
        return f.lease;
      };
    if (kind === 'cookie-race')
      f.options.readCookie = async () => {
        f.advance(30_000);
        return f.current;
      };
    await assert.rejects(renewManualPreviewLease(f.options), /REFUSED|PROOF_OBSERVATION_DEADLINE/);
    assert.ok(f.calls.filter((v) => v === 'owner-renew').length <= 1);
    if (kind === 'owner-refusal' || kind === 'before' || kind === 'owner-race')
      assert.ok(!f.calls.includes('same-cookie-redelivery'));
  }
});

test('manual Generate and Discard capacity use minimum real cookie/server/absolute/host expiry with no future renew assumption', () => {
  for (const boundary of ['generate', 'discard']) {
    const f = manualRenewalFixture(),
      requiredMs = manualLeaseEstimate[boundary];
    const args = {
      cookie: f.current,
      lease: f.lease,
      generation: 1,
      hostDeadline: f.start + 800_000,
      requiredMs,
      now: f.start,
    };
    assert.ok(manualLeaseDeadline(args) > f.start);
    for (const limiting of ['cookie', 'server', 'absolute', 'host']) {
      const input = structuredClone(args),
        end = f.start + requiredMs + 14_999;
      if (limiting === 'cookie') input.cookie.cookieExpiresAt = new Date(end).toISOString();
      if (limiting === 'server') input.lease.leaseExpiresAt = new Date(end).toISOString();
      if (limiting === 'absolute') input.lease.absoluteExpiresAt = new Date(end).toISOString();
      if (limiting === 'host') input.hostDeadline = end;
      assert.throws(() => manualLeaseDeadline(input), /PROOF_MANUAL_LEASE_INSUFFICIENT/, limiting);
    }
    assert.throws(() => manualLeaseDeadline({ ...args, now: f.start + 300_000 }), /INSUFFICIENT/);
  }
});

test('first helper auth-loss evidence is bounded and redacted independently of the rolling tail', () => {
  const first = {
    elapsedMs: 301_000,
    status: 401,
    route: 'status',
    cookiePresent: false,
    helperTokenMatches: true,
    cookie: 'private-bearer-canary',
  };
  const observed = boundedHelperAuthLoss({
    previous: { ...first, elapsedMs: 299_000, status: 200, cookiePresent: true },
    first,
  });
  assert.equal(observed.previous.status, 200);
  assert.equal(observed.first.elapsedMs, 301_000);
  assert.ok(!JSON.stringify(observed).includes('canary'));
  assert.equal(boundedHelperAuthLoss({ first: { ...first, status: 200 } }), null);
  const browser = readFileSync(
    new URL('./live-production-edit-browser.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(browser.includes('JSON.stringify({ firstHelperAuthLoss })'));
});

function currentPostSteerHandler(overrides = {}) {
  const source = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf("const phaseA = command === 'accepted-poll-observed';");
  const end = source.indexOf("} else if (command === 'steered')", start);
  const body = source.slice(start, end);
  const values = {
    command: 'steered-poll-observed',
    editingPhase: 'steer',
    acceptedCanonicalAcknowledged: true,
    steeredCanonicalAcknowledged: true,
    backgroundFinished: true,
    assert,
    observedBirthExited: () => false,
    baselineBirth: {},
    observation: { deadline: Date.now() + 200 },
    editingRemaining: () => 200,
    editingPhaseRemaining: () => 200,
    editingAnchor: {},
    pendingCanonicalPoll: () => null,
    session: { id: 'session' },
    started: { generation: 3 },
    observePostAcceptPollDispatch,
    report: { checks: {} },
    ...overrides,
  };
  return {
    run: new Function(...Object.keys(values), 'return async () => {' + body + '}')(
      ...Object.values(values),
    ),
    report: values.report,
  };
}

test('current B handler waits through pending authority for the original signed poll after Steer/background', async () => {
  const flight = {
    sequence: 33,
    commandIpcDispatched: true,
    workerBirthsCurrent: true,
    postAuthority: true,
    pending: true,
    generationMatches: true,
    foregroundChildBirthObserved: false,
  };
  let reads = 0;
  const h = currentPostSteerHandler({
    pendingCanonicalPoll: (session, generation) => {
      assert.equal(session, 'session');
      assert.equal(generation, 3);
      return ++reads < 3 ? null : flight;
    },
  });
  assert.equal(await h.run(), flight);
  assert.equal(reads, 3);
  assert.equal(h.report.checks.authenticPostSteerPollDispatchedBeforeBrowserClose, true);
});

test('current B handler refuses missing canonical/background authority, exited owner, stale IPC and exhausted B cutoff', async () => {
  for (const changed of [
    { steeredCanonicalAcknowledged: false },
    { backgroundFinished: false },
    { observedBirthExited: () => true },
    { editingPhase: 'accepted' },
    { observation: { deadline: Date.now() - 1 } },
    { pendingCanonicalPoll: () => ({ sequence: 1, postAuthority: false }) },
  ]) {
    const h = currentPostSteerHandler(changed);
    await assert.rejects(h.run());
    assert.equal(h.report.checks.authenticPostSteerPollDispatchedBeforeBrowserClose, undefined);
  }
});

test('current host renewal correlates exact private SQLite row among peers and attempts authenticated API once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'l11-exact-cookie-renew-'));
  mkdirSync(join(root, '.codex-gestalt/gestalt-mobile'), { recursive: true });
  const db = new DatabaseSync(join(root, '.codex-gestalt/gestalt-mobile/live-auth.sqlite'));
  const source = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf(
    "assert.equal(proofLane, 'manual-discard');",
    source.indexOf("'manual-lease-before-generate'"),
  );
  const end = source.indexOf("} else if (command === 'accepted')", start);
  const tokenDigest = 'a'.repeat(64),
    privateSession = 'private-test-session-canary';
  const hash = (v) => createHash('sha256').update(v).digest('hex');
  const now = Date.now();
  let clock = now;
  const expected = {
    relayId: 'relay',
    appId: 'owning-app',
    liveId: 'live',
    generation: 1,
    previewOrigin: 'https://preview.test:9443',
    authSessionHash: hash(privateSession),
    deviceId: 'fixture-device',
    leaseId: 'actual',
    tokenHash: tokenDigest,
    exchangedAt: new Date(now - 135_000).toISOString(),
    renewedAt: null,
    leaseExpiresAt: new Date(now + 160_000).toISOString(),
    absoluteExpiresAt: new Date(now + 3_000_000).toISOString(),
  };
  const report = {};
  let calls = 0;
  const values = {
    assert,
    proofLane: 'manual-discard',
    command: 'manual-lease-before-generate',
    manualLeaseStages: new Set(),
    manualLeaseReceipts: [],
    source: () => 'Production discarded variant',
    acknowledged: async (kind) => {
      assert.equal(kind, 'generate');
    },
    manualSource: 'canonical acknowledged manual edit',
    proofObservationRemaining,
    observation: {
      deadline: now + 30_000,
      cookie: { tokenDigest, cookieExpiresAt: expected.leaseExpiresAt },
    },
    observedBirthExited: () => false,
    baselineBirth: {},
    session: { id: 'relay' },
    started: { liveId: 'live', generation: 1 },
    preview: expected.previewOrigin,
    previewSecrets: { hash },
    browserSession: privateSession,
    DatabaseSync,
    join,
    home: root,
    assertPreviewLeaseIdentity: (lease, cookie, audience) =>
      assertPreviewLeaseIdentity(lease, cookie, audience, clock),
    Date: { now: () => clock, parse: Date.parse },
    hash,
    report,
    api: async (method, url, body) => {
      calls++;
      assert.equal(method, 'POST');
      assert.equal(url, '/api/sessions/relay/live/leases/actual/renew');
      assert.deepEqual(body, { liveId: 'live', generation: 1 });
      const after = {
        ...JSON.parse(
          db.prepare('SELECT record FROM live_leases WHERE token_hash=?').get(tokenDigest).record,
        ),
        renewedAt: new Date(clock).toISOString(),
        leaseExpiresAt: new Date(clock + 300_000).toISOString(),
      };
      db.prepare('UPDATE live_leases SET record=? WHERE token_hash=?').run(
        JSON.stringify(after),
        tokenDigest,
      );
      return { leaseExpiresAt: after.leaseExpiresAt, absoluteExpiresAt: after.absoluteExpiresAt };
    },
  };
  try {
    db.exec('CREATE TABLE live_leases (token_hash TEXT PRIMARY KEY, record TEXT)');
    db.prepare('INSERT INTO live_leases VALUES (?, ?)').run(
      'b'.repeat(64),
      JSON.stringify({ ...expected, leaseId: 'peer', tokenHash: 'b'.repeat(64) }),
    );
    db.prepare('INSERT INTO live_leases VALUES (?, ?)').run(tokenDigest, JSON.stringify(expected));
    const run = new Function(
      ...Object.keys(values),
      'return async () => {' + source.slice(start, end) + '}',
    )(...Object.values(values));
    const actual = await run();
    assert.equal(calls, 1);
    assert.equal(actual.ownerRenewals, 1);
    assert.equal(actual.sameLeaseAndToken, true);
    assert.equal(actual.leaseDigest, hash('actual'));
    assert.ok(!JSON.stringify(report).includes(privateSession));
    await assert.rejects(run());
    assert.equal(calls, 1);
    assert.equal(
      JSON.parse(
        db.prepare('SELECT record FROM live_leases WHERE token_hash=?').get('b'.repeat(64)).record,
      ).renewedAt,
      null,
    );
    const runCurrent = () =>
      new Function(...Object.keys(values), 'return async () => {' + source.slice(start, end) + '}')(
        ...Object.values(values),
      );
    values.command = 'manual-lease-before-discard';
    values.manualLeaseStages = new Set(['before-generate']);
    values.manualLeaseReceipts = [actual];
    clock = now + 20_000;
    values.observation = {
      deadline: clock + 30_000,
      cookie: { tokenDigest, cookieExpiresAt: actual.leaseExpiresAt },
    };
    const retained = await runCurrent()();
    assert.equal(retained.renewed, false);
    assert.equal(retained.ownerRenewals, 1);
    assert.equal(calls, 1);
    // Independent later-stage branch under the measured elapsed time; not a retry.
    values.manualLeaseStages = new Set(['before-generate']);
    values.manualLeaseReceipts = [actual];
    clock = now + 166_654;
    values.observation = {
      deadline: clock + 30_000,
      cookie: { tokenDigest, cookieExpiresAt: actual.leaseExpiresAt },
    };
    const second = runCurrent();
    const renewedSecond = await second();
    assert.equal(renewedSecond.renewed, true);
    assert.equal(renewedSecond.ownerRenewals, 2);
    assert.equal(renewedSecond.leaseDigest, actual.leaseDigest);
    assert.equal(calls, 2);
    await assert.rejects(second());
    assert.equal(calls, 2);
    values.command = 'manual-lease-before-generate';
    clock = now;
    values.observation = {
      deadline: now + 30_000,
      cookie: { tokenDigest, cookieExpiresAt: expected.leaseExpiresAt },
    };
    for (const mutation of [
      { generation: 2 },
      { deviceId: 'peer' },
      { authSessionHash: 'peer' },
      { previewOrigin: 'https://preview.test:9444' },
    ]) {
      db.prepare('UPDATE live_leases SET record=? WHERE token_hash=?').run(
        JSON.stringify({ ...expected, ...mutation }),
        tokenDigest,
      );
      values.manualLeaseStages = new Set();
      values.manualLeaseReceipts = [];
      const refused = new Function(
        ...Object.keys(values),
        'return async () => {' + source.slice(start, end) + '}',
      )(...Object.values(values));
      await assert.rejects(refused(), /PROOF_MANUAL_LEASE_IDENTITY/);
      assert.equal(calls, 2);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('named second stage can retain sufficient real capacity before60s without any owner renewal/redelivery', async () => {
  const f = manualRenewalFixture();
  f.lease.stage = 'before-discard';
  f.lease.renewed = false;
  f.current.cookieExpiresAt = f.cookie.cookieExpiresAt = new Date(f.start + 270_000).toISOString();
  f.lease.leaseExpiresAt = f.current.cookieExpiresAt;
  const result = await renewManualPreviewLease({
    ...f.options,
    stage: 'before-discard',
    requiredMs: manualLeaseEstimate.discard,
  });
  assert.equal(result.lease.renewed, false);
  assert.deepEqual(f.calls, ['owner-renew', 'actual-browser-cookie']); // Callback observes host receipt; no API dispatch.
  assert.ok(!f.calls.includes('same-cookie-redelivery'));
  f.current.cookieExpiresAt = f.cookie.cookieExpiresAt = new Date(f.start + 200_000).toISOString();
  await assert.rejects(
    renewManualPreviewLease({
      ...f.options,
      stage: 'before-discard',
      requiredMs: manualLeaseEstimate.discard,
    }),
    /PROOF_MANUAL_LEASE_INSUFFICIENT/,
  );
});

test('renewal stage mismatch cannot substitute first-stage authority for the second named stage', async () => {
  const f = manualRenewalFixture();
  await assert.rejects(
    renewManualPreviewLease({
      ...f.options,
      stage: 'before-discard',
      requiredMs: manualLeaseEstimate.discard,
    }),
    /PROOF_MANUAL_LEASE_IDENTITY/,
  );
  assert.deepEqual(f.calls, ['owner-renew']);
});

test('owned manual sequence timeout closes actual action port and stays pending until original work drains; no late edit', async () => {
  let release,
    abortCalled = false,
    returned = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [],
    observations = [];
  const run = ownedProofSequence({
    deadline: Date.now() + 30,
    steps: [
      () => {
        calls.push('prepare');
        return pending;
      },
      () => {
        calls.push('edit');
      },
    ],
    abort: async () => {
      abortCalled = true;
    },
    observe: (v) => observations.push(v),
  }).finally(() => {
    returned = true;
  });
  const rejected = assert.rejects(run, /PROOF_OBSERVATION_DEADLINE/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(abortCalled, true);
  assert.equal(returned, false);
  assert.deepEqual(calls, ['prepare']);
  assert.equal(observations[0].pendingOwned, true);
  assert.equal(observations[0].drained, false);
  release();
  await rejected;
  assert.deepEqual(calls, ['prepare']);
  assert.equal(returned, true);
  assert.deepEqual(observations.at(-1), {
    timedOut: true,
    pendingOwned: false,
    drained: true,
    contextClosed: true,
  });
});

test('owned sequence propagates exact active command refusal and fences later steps or an expired initial dispatch', async () => {
  const refusal = Error('EXACT_ACTIVE_REFUSAL');
  let later = 0,
    aborts = 0;
  await assert.rejects(
    ownedProofSequence({
      deadline: Date.now() + 1000,
      steps: [
        async () => {
          throw refusal;
        },
        () => {
          later++;
        },
      ],
      abort: async () => {
        aborts++;
      },
    }),
    (error) => error === refusal,
  );
  await assert.rejects(
    ownedProofSequence({
      deadline: Date.now() - 1,
      steps: [
        () => {
          later++;
        },
      ],
      abort: async () => {
        aborts++;
      },
    }),
    /PROOF_OBSERVATION_DEADLINE/,
  );
  let now = Date.now();
  const deadline = now + 1000;
  await assert.rejects(
    ownedProofSequence({
      deadline,
      now: () => now,
      steps: [
        async () => {
          now = deadline;
        },
        () => {
          later++;
        },
      ],
      abort: async () => {
        aborts++;
      },
    }),
    /PROOF_OBSERVATION_DEADLINE/,
  );
  assert.equal(later, 0);
  assert.equal(aborts, 0);
});

test('owned sequence does not call cleanup complete while context closure is pending after work settles', async () => {
  let close,
    settle,
    returned = false;
  const work = new Promise((resolve) => {
    settle = resolve;
  });
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const run = ownedProofSequence({
    deadline: Date.now() + 25,
    steps: [() => work],
    abort: () => closed,
  }).finally(() => {
    returned = true;
  });
  const rejected = assert.rejects(run, /PROOF_OBSERVATION_DEADLINE/);
  await new Promise((resolve) => setTimeout(resolve, 40));
  settle();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(returned, false);
  close();
  await rejected;
  assert.equal(returned, true);
});

test('post-Discard observer uses current exact original flight only after canonical Discard and stage2 evaluation', async () => {
  const flight = {
    sequence: 44,
    commandIpcDispatched: true,
    workerBirthsCurrent: true,
    postAuthority: true,
    pending: true,
    generationMatches: true,
    foregroundChildBirthObserved: false,
  };
  const defaults = {
    command: 'discarded-poll-observed',
    editingPhase: undefined,
    proofLane: 'manual-discard',
    discardedCanonicalAcknowledged: true,
    manualLeaseStages: new Set(['before-generate', 'before-discard']),
    source: () => 'restored-manual-source',
    manualSource: 'restored-manual-source',
  };
  // Reuse the current handler extraction; supply the manual branch's actual environment.
  const current = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  const start = current.indexOf("const phaseA = command === 'accepted-poll-observed';");
  const end = current.indexOf("} else if (command === 'steered')", start);
  for (const mutation of [
    {},
    { discardedCanonicalAcknowledged: false },
    { manualLeaseStages: new Set(['before-generate']) },
    { source: () => 'wrong-source' },
    { observation: { deadline: Date.now() - 1 } },
    { pendingCanonicalPoll: () => ({ ...flight, generationMatches: false }) },
  ]) {
    let reads = 0;
    const values = {
      ...defaults,
      assert,
      observedBirthExited: () => false,
      baselineBirth: {},
      observation: { deadline: Date.now() + 1000 },
      editingAnchor: null,
      editingRemaining: () => 1000,
      pendingCanonicalPoll: (relay, generation) => {
        assert.equal(relay, 'relay');
        assert.equal(generation, 1);
        return ++reads < 2 ? null : flight;
      },
      session: { id: 'relay' },
      started: { generation: 1 },
      observePostAcceptPollDispatch,
      report: { checks: {} },
      ...mutation,
    };
    const run = new Function(
      ...Object.keys(values),
      'return async () => {' + current.slice(start, end) + '}',
    )(...Object.values(values));
    if (Object.keys(mutation).length) await assert.rejects(run());
    else {
      assert.equal(await run(), flight);
      assert.equal(reads, 2);
    }
  }
});

test('actual host-finally command join remains owned across browser timeout until the original callback settles', async () => {
  const source = readFileSync(
    new URL('./live-production-edit-browser-host.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('input.report.editBrowserCommandsDrained = false;');
  const last = 'input.report.editBrowserCommandsDrained = true;';
  const body = source.slice(start, source.indexOf(last, start) + last.length);
  assert.ok(start > 0);
  let finish;
  const commands = new Promise((resolve) => {
    finish = resolve;
  });
  const input = { report: {} };
  const join = new Function('input', 'commands', 'return async () => {' + body + '}')(
    input,
    commands,
  );
  let returned = false;
  const waiting = join().then(() => {
    returned = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(returned, false);
  assert.equal(input.report.editBrowserCommandsDrained, false);
  finish();
  await waiting;
  assert.equal(input.report.editBrowserCommandsDrained, true);
  const failed = { report: {} };
  await new Function('input', 'commands', 'return async () => {' + body + '}')(
    failed,
    Promise.reject(Error('EXACT_REPLY_REFUSAL')),
  )();
  assert.equal(failed.report.editBrowserCommandDrainFailed, true);
  assert.equal(failed.report.editBrowserCommandsDrained, true);
});

test('actual browser command timeout retires and drains its original readline reply without reissuing the command', async () => {
  const source = readFileSync(
    new URL('./live-production-edit-browser.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('async function command(value, deadline, details) {');
  const end = source.indexOf('\ntry {', start);
  const input = new PassThrough(),
    replyLines = createInterface({ input });
  const raw = replyLines[Symbol.asyncIterator]();
  let originalSettled = false,
    reads = 0,
    writes = 0;
  const replies = {
    next: () => {
      reads++;
      return raw.next().finally(() => {
        originalSettled = true;
      });
    },
  };
  const command = new Function(
    'process',
    'replyLines',
    'replies',
    'withinProofObservation',
    'assert',
    source.slice(start, end) + '; return command;',
  )(
    {
      stdin: input,
      stdout: {
        write: () => {
          writes++;
        },
      },
    },
    replyLines,
    replies,
    withinProofObservation,
    assert,
  );
  await assert.rejects(command('discarded', Date.now() + 25), /PROOF_OBSERVATION_DEADLINE/);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(originalSettled, true);
  assert.equal(input.destroyed, true);
});

test('only the exact explicitly tagged original GET poll403 probe is expected; all other auth loss survives', () => {
  const origin = 'https://preview.test:9443';
  const original = { method: () => 'GET', url: () => origin + '/__gestalt_live/poll' };
  const response = (request, status = 403) => ({ request: () => request, status: () => status });
  assert.equal(expectedPollProbeResponse(response(original), original, origin), true);
  for (const [request, status, expected] of [
    [{ ...original }, 403, original],
    [original, 401, original],
    [original, 403, undefined],
  ])
    assert.equal(expectedPollProbeResponse(response(request, status), expected, origin), false);
  for (const mutation of [
    { method: () => 'POST' },
    { url: () => origin + '/__gestalt_live/status' },
    { url: () => origin + '/__gestalt_live/lease' },
  ]) {
    const request = { ...original, ...mutation };
    assert.equal(expectedPollProbeResponse(response(request), request, origin), false);
  }
  assert.equal(
    expectedPollProbeResponse(response(original), original, 'https://other.test'),
    false,
  );
});

function serialBinding() {
  return {
    trialId: 'serial-accept-baseline-1',
    identity: {
      candidate: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      runId: '123',
      native: 'c'.repeat(64),
      manager: 'd'.repeat(64),
      managerTree: 'e'.repeat(40),
      agents: 'f'.repeat(40),
    },
    birth: { pid: 123, start: '1', boot: '0'.repeat(36) },
    anchor: { boot: '0'.repeat(36), monotonicNs: '0' },
    phaseA: { phase: 'accepted', startedNs: '0', deadlineNs: '1260000000000' },
  };
}
test('serial profile keeps exact raw operations pending across cancellation and retains the first fixed failure only', async () => {
  let at = 1_000_000n,
    release;
  const profile = createSerialProfile(serialBinding(), () => at);
  const raw = new Promise((resolve) => {
    release = resolve;
  });
  assert.equal(
    profile.trace('idempotent-start', () => raw, { generation: 1 }),
    raw,
  );
  assert.equal(profile.report.spans[0].endNs, null);
  profile.failure('PROOF_DRIVER_PHASE_DEADLINE');
  profile.failure('PROOF_CANCELLED');
  profile.failure('private-token-canary');
  assert.equal(profile.report.spans[0].outcome, 'pending');
  assert.equal(profile.report.spans[0].endNs, null);
  at += 10_000_000n;
  release('original');
  assert.equal(await raw, 'original');
  assert.equal(profile.report.spans[0].endNs, at.toString());
  assert.equal(profile.report.firstFailure.code, 'PROOF_DRIVER_PHASE_DEADLINE');
  assert.ok(!JSON.stringify(profile.report).includes('canary'));
});
test('serial profile rejects payload-shaped bindings, labels, stale clocks and nonexistent or changed attribution without dispatch', () => {
  let calls = 0;
  const binding = serialBinding();
  for (const change of [
    { credential: 'bearer-canary' },
    { trialId: 'other' },
    { identity: { ...binding.identity, token: 'canary' } },
    { anchor: { ...binding.anchor, boot: '1'.repeat(36) } },
  ])
    assert.throws(() => createSerialProfile({ ...binding, ...change }), /PROOF_PROFILE_INVALID/);
  const profile = createSerialProfile(binding, () => 100n);
  assert.throws(
    () =>
      profile.trace('private-label', () => {
        calls++;
      }),
    /PROOF_PROFILE_INVALID/,
  );
  for (const metadata of [
    { token: 'canary' },
    { parentId: 'profile-9999' },
    { generation: 0 },
    { eventDigest: 'private-value' },
  ])
    assert.throws(
      () =>
        profile.trace(
          'idempotent-start',
          () => {
            calls++;
          },
          metadata,
        ),
      /PROOF_PROFILE_INVALID/,
    );
  assert.equal(calls, 0);
  assert.throws(() => profile.begin('browser-close', {}, 101n), /PROOF_PROFILE_INVALID/);
  const id = profile.begin('browser-close', {}, 80n);
  profile.end(id, 'completed', 90n);
  assert.throws(() => profile.end(id, 'completed'), /PROOF_PROFILE_INVALID/);
  binding.anchor.monotonicNs = '10000000000000';
  assert.ok(profile.begin('accept-ack'));
});
test('actual authority observer profile grants only after original validation and correlates Generate with its actual work', async () => {
  let permit, finish;
  const validated = new Promise((resolve) => {
      permit = resolve;
    }),
    raw = new Promise((resolve) => {
      finish = resolve;
    });
  const profile = createSerialProfile(serialBinding()),
    records = [],
    eventDigest = 'a'.repeat(64);
  const target = {
    async liveEvent(fence, eventId, work) {
      await validated;
      return work();
    },
  };
  observeEventAuthority(target, records, () => 'open', {
    trace: (fence, eventId, work) =>
      profile.trace('generate-authority', work, { generation: fence.generation, eventDigest }),
    granted: () => profile.granted(),
  });
  const result = target.liveEvent({ generation: 1 }, 'abcdef12', () => raw);
  assert.equal(profile.report.spans[0].grantedNs, undefined);
  assert.throws(() => profile.eventParent(eventDigest), /PROOF_PROFILE_INVALID/);
  permit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(profile.eventParent(eventDigest), profile.report.spans[0].id);
  const child = profile.begin('root-confinement', { parentId: profile.eventParent(eventDigest) });
  assert.equal(profile.report.spans[1].parentId, profile.report.spans[0].id);
  assert.equal(profile.report.spans[0].endNs, null);
  finish('exact');
  assert.equal(await result, 'exact');
  profile.end(child, 'completed');
  assert.equal(records[0].completed, true);
});
test('request attribution survives overlapping actual admission observers without leaking to unrelated calls', async () => {
  const profile = createSerialProfile(serialBinding());
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const rpc = {
    request: async () => {
      await gate;
      return 'catalog';
    },
  };
  const runtime = {
    inspectLiveAdmission: () =>
      rpc.request('mcpServerStatus/list', {
        serverName: 'context-mode',
        threadId: 'owning',
        detail: 'full',
      }),
  };
  const controller = { verifyProjectResources: () => 'resources' };
  const timing = observeAdmissionTimings(runtime, controller, () => profile.currentId());
  timing.observeRpc(rpc);
  const first = profile.trace('idempotent-start', () => runtime.inspectLiveAdmission());
  const second = profile.trace('poll-authority', () => runtime.inspectLiveAdmission());
  const unrelated = runtime.inspectLiveAdmission();
  release();
  await Promise.all([first, second, unrelated]);
  for (const id of profile.report.spans.map((row) => row.id)) {
    const rows = timing.report.calls.filter((row) => row.profileId === id);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      new Set(rows.map((row) => row.operation)),
      new Set(['admission-inspection', 'admission-catalog-context']),
    );
  }
  assert.equal(timing.report.calls.filter((row) => row.profileId === undefined).length, 2);
  assert.equal(profile.currentId(), null);
});
test('serial instrumentation preserves rejected operation identity and fixed refusal without raw error content', async () => {
  const profile = createSerialProfile(serialBinding()),
    sentinel = new Error('private-bearer-canary');
  const raw = Promise.reject(sentinel);
  assert.equal(
    profile.trace('idempotent-start', () => raw),
    raw,
  );
  await assert.rejects(raw, (error) => error === sentinel);
  assert.equal(profile.report.spans[0].outcome, 'refused');
  assert.ok(!JSON.stringify(profile.report).includes('canary'));
});

test('actual source-patch observer ends only after matching original tool output and existing exact-source validation', () => {
  const source = readFileSync(
    new URL('./live-production-entrypoint-proof.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('const editResponse = (body, toolCall) => {'),
    end = source.indexOf('\nlet seed', start);
  const profile = createSerialProfile(serialBinding());
  const pending = { id: profile.begin('first-source-patch'), callId: 'root-6', settled: false };
  let sourceValid = false;
  const original = () => {
    assert.ok(sourceValid, 'ACTUAL_SOURCE_NOT_YET_VALID');
    return 'exact';
  };
  const observe = new Function(
    'originalEditResponse',
    'serialProfile',
    'sourcePatchProfile',
    source.slice(start, end) + ';return editResponse;',
  )(original, profile, pending);
  const exact = {
    input: [{ call_id: 'root-6', type: 'custom_tool_call_output', output: 'private-canary' }],
  };
  assert.throws(() => observe(exact), /ACTUAL_SOURCE_NOT_YET_VALID/);
  assert.equal(profile.report.spans[0].endNs, null);
  sourceValid = true;
  assert.equal(
    observe({ input: [{ call_id: 'root-5', type: 'custom_tool_call_output' }] }),
    'exact',
  );
  assert.equal(profile.report.spans[0].endNs, null);
  assert.equal(observe(exact), 'exact');
  assert.equal(pending.settled, true);
  assert.equal(profile.report.spans[0].outcome, 'completed');
  assert.ok(!JSON.stringify(profile.report).includes('canary'));
});

// Dependency-backed injection test belongs after npm ci, not selection bootstrap.
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

async function dependencyPreparedEditingHandoff({
  left = 5000,
  onCancel = async () => {},
  onFailure = () => {},
} = {}) {
  const identity = { ...serialBinding().identity, ...proofPins };
  const directory = mkdtempSync(join(tmpdir(), 'l11-injection-after-deps-')),
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
testWithEditingClock(
  'actual Fastify injection keeps one original request when cancellation joins its retained thenable',
  async () => {
    const { default: fastify } = await import('fastify');
    const mobile = fastify(),
      editingApiRaw = new Set();
    let release,
      enter,
      calls = 0,
      stopped = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    mobile.post('/pending', async () => {
      calls++;
      enter();
      await gate;
      return { actual: true };
    });
    await mobile.ready();
    const h = await dependencyPreparedEditingHandoff({
      left: 120,
      onCancel: async () => {
        await Promise.allSettled([...editingApiRaw]);
        stopped = true;
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
    )(h.handoff, mobile, {}, {}, true, editingApiRaw);
    try {
      const pending = api('POST', '/pending', {}),
        refused = assert.rejects(pending, /PROOF_DRIVER_PHASE_DEADLINE/);
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(calls, 1);
      assert.equal(editingApiRaw.size, 1);
      assert.equal(stopped, false);
      release();
      await refused;
      await h.handoff.close();
      assert.equal(calls, 1);
      assert.equal(editingApiRaw.size, 0);
      assert.equal(stopped, true);
    } finally {
      release();
      await h.handoff.close();
      await mobile.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  },
);
