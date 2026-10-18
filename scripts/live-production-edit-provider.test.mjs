/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Fixture contract tests; these do not claim actual Native model execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  observeInstalledPolicyTimings,
  cleanupControllerSnapshot,
} from './live-production-edit-diagnostics.mjs';
import { JSDOM } from 'jsdom';
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
