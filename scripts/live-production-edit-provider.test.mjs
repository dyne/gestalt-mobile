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
import {
  safeBrowserFailure,
  pickerChromeSnapshot,
  boundedPickerObservation,
  observeProofMethod,
  observeEventAuthority,
  proofObservationRemaining,
  withinProofObservation,
  pickerContinuityProbe,
  observePickerContinuity,
  observeCanonicalPollDispatch,
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
} from './live-production-edit-diagnostics.mjs';
import { JSDOM } from 'jsdom';
import { processBirth, birthCurrent } from './live-production-proof-lanes.mjs';
import {
  createProductionEditProvider,
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
