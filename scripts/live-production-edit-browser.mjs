/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  safeBrowserFailure,
  observePreviewExchange,
  observeEditingSteer,
  pickerChromeSnapshot,
  observePickerContinuity,
  withinProofObservation,
  manualObservationDeadline,
  proofObservationRemaining,
  boundedManualCommitObservation,
  previewCookieObservation,
  renewManualPreviewLease,
  manualLeaseDeadline,
  manualLeaseEstimate,
  ownedProofSequence,
} from './live-production-edit-diagnostics.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
let stage = 'start';
let browser;
let browserProcess;
let browserExit;
const chromeStartupMarkers = new Set();
let chromeStartupComplete = false;
const chromeComponents = [];
const chromeChecks = [];
let baselineSandboxedLaunch;
let launcherKernel;
const networkErrors = [];
const networkResourceFailures = [];
let initialMobileAssetsChanged = false;
const exchangeStatuses = [];
const resourcePending = {};
const resourceStatuses = {};
const pageErrors = [];
const helperResponses = [];
let firstHelperAuthLoss, lastAuthenticatedHelper;
const editRequests = [];
let manualEntryDigest, manualCommit, manualCommitDeadline;
const emitManualCommitObservation = (boundary) => {
  if (!manualCommit) return;
  const observed = boundedManualCommitObservation({
    boundary,
    ...manualCommit,
    deadline: manualCommitDeadline,
  });
  if (observed) process.stdout.write(JSON.stringify({ manualCommitObservation: observed }) + '\n');
};
let manualCommitCount = 0;
const editKinds = ['generate', 'steer', 'accept', 'discard', 'manual_edit_apply'];
// A measured source/selection/catalog/provenance/resource authority check takes
//111s before turn/start. Observe both authority/helper windows without changing
// the upstream595s lease, source checks, replay rules or any product deadline.
if (!config.preflight && !config.startThroughControls)
  assert.equal(config.eventObservationBudgetMs, 300_000);
const modelEffectTimeout = config.eventObservationBudgetMs ?? 90_000;
const terminalEffectTimeout = config.eventObservationBudgetMs ?? 60_000;
let helperBridge;
let previewNavigationCount = 0;
const browserStarted = Date.now();
let initialPreviewGetRetried = false;
const checkpoint = (value) => {
  stage = value;
  process.stdout.write(
    JSON.stringify({ checkpoint: value, elapsedMs: Date.now() - browserStarted }) + '\n',
  );
};
const replyLines = createInterface({ input: process.stdin });
const replies = replyLines[Symbol.asyncIterator]();
async function command(value, deadline, details) {
  process.stdout.write(
    JSON.stringify({
      command: value,
      observation: deadline ? { deadline, ...details } : undefined,
    }) + '\n',
  );
  const pendingReply = replies.next();
  let reply;
  try {
    reply = deadline
      ? await withinProofObservation(() => pendingReply, deadline)
      : await pendingReply;
  } catch (error) {
    // Terminal observation failure: close IPC and join the exact original read.
    // The host independently retains its callback until actual settlement.
    replyLines.close();
    process.stdin.destroy();
    await pendingReply.catch(() => {});
    throw error;
  }
  const result = JSON.parse(reply.value);
  assert.equal(result.ok, true);
  return result.observation;
}
try {
  checkpoint('namespace');
  assert.equal(await readlink('/proc/self/ns/net'), config.browserNetwork);
  assert.notEqual(config.browserNetwork, config.serverNetwork);
  assert.notEqual(await readlink('/proc/self/ns/mnt'), config.serverMount);
  checkpoint('ui-import');
  const ui = config.preflight ? undefined : await import(pathToFileURL(config.uiModule).href);
  checkpoint('browser-launch');
  if (config.preflight) {
    const status = await readFile('/proc/self/status', 'utf8');
    launcherKernel = Object.fromEntries(
      [
        'Uid',
        'Gid',
        'CapInh',
        'CapPrm',
        'CapEff',
        'CapBnd',
        'CapAmb',
        'NoNewPrivs',
        'Seccomp',
      ].flatMap((name) => {
        const value = new RegExp(`^${name}:\\s+([0-9a-f \\t]+)$`, 'm').exec(status)?.[1];
        return value ? [[name, value.trim().replace(/\s+/g, ' ')]] : [];
      }),
    );
    let baseline;
    try {
      baseline = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        timeout: 10000,
        env: {
          ...process.env,
          HOME: config.browserHome,
          HTTP_PROXY: '',
          HTTPS_PROXY: '',
          ALL_PROXY: '',
        },
      });
      await (await baseline.newPage()).goto('about:blank');
      baselineSandboxedLaunch = true;
    } catch {
      baselineSandboxedLaunch = false;
    } finally {
      await baseline?.close();
    }
  }
  // Playwright's normal launch forces page focus/visibility. Attach without
  // overrides to a fresh owned Chrome profile so backgrounding is real.
  const profile = join(config.browserHome, 'chromium-profile');
  await mkdir(profile, { mode: 0o700 });
  browserProcess = spawn(
    chromium.executablePath(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
      `--host-resolver-rules=MAP *.preview.entrypoint.test ${config.hostAddress}, MAP preview.entrypoint.test ${config.hostAddress}, MAP mobile.entrypoint.test ${config.hostAddress}`,
      '--no-proxy-server',
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HOME: config.browserHome,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
    },
  );
  browserExit = new Promise((resolve) => browserProcess.once('close', resolve));
  browserProcess.on('error', () => {});
  browserProcess.stderr.on('data', (chunk) => {
    if (chromeStartupComplete) return;
    const text = String(chunk);
    for (const match of text.matchAll(/(?:FATAL|ERROR):([a-zA-Z0-9_./-]+\.(?:cc|h)):(\d+)/g)) {
      if (chromeComponents.length < 16)
        chromeComponents.push({ source: match[1], line: Number(match[2]) });
    }
    for (const match of text.matchAll(/Check failed: ([^\n]{1,180})/g)) {
      const condition = /^[a-zA-Z0-9_().!<>=&| :+-]+$/.test(match[1]) ? match[1] : 'NON_CODE_CHECK';
      if (chromeChecks.length < 8) chromeChecks.push(condition);
    }
    for (const [marker, code] of [
      ['No usable sandbox', 'SANDBOX_UNAVAILABLE'],
      ['Failed to move to new namespace', 'NAMESPACE'],
      ['SUID sandbox helper binary', 'SUID_SANDBOX'],
      ['Running as root without', 'ROOT_SANDBOX'],
      ['chrome_crashpad_handler', 'CRASHPAD'],
      ['--database is required', 'CRASHPAD_DATABASE_REQUIRED'],
      ['error while loading shared libraries', 'SHARED_LIBRARY'],
      ['Permission denied', 'EACCES'],
      ['Operation not permitted', 'EPERM'],
      ['Missing X server', 'DISPLAY'],
    ])
      if (text.includes(marker)) chromeStartupMarkers.add(code);
  });
  let debugPort;
  const launchDeadline = Date.now() + 30000;
  while (Date.now() < launchDeadline) {
    try {
      const lines = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
      if (/^[1-9][0-9]{0,4}$/.test(lines[0]) && Number(lines[0]) <= 65535) {
        debugPort = lines[0];
        break;
      }
    } catch {
      /* Private startup publication is asynchronous. */
    }
    if (browserProcess.exitCode !== null || browserProcess.signalCode !== null)
      throw new Error('BROWSER_STARTUP_FAILED');
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok(debugPort, 'BROWSER_STARTUP_DEADLINE');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
    noDefaults: true,
    isLocal: true,
  });
  const context = browser.contexts()[0];
  assert.ok(context);
  chromeStartupComplete = true;
  if (config.preflight) {
    const first = context.pages()[0] ?? (await context.newPage());
    const foreground = await context.newPage();
    await foreground.bringToFront();
    await first.waitForFunction(() => document.visibilityState === 'hidden', undefined, {
      polling: 100,
      timeout: 5000,
    });
    await writeFile(
      config.resultFile,
      JSON.stringify({
        browserStartup: true,
        actualHiddenTab: true,
        separateBrowserNetwork: true,
        separateBrowserMountNamespace: true,
        noNativeOrProvider: true,
      }),
    );
    throw new Error('BROWSER_PREFLIGHT_COMPLETE');
  }
  context.on('page', (page) => {
    page.on('pageerror', (error) => {
      if (pageErrors.length < 8) pageErrors.push(safeBrowserFailure(error.message));
    });
  });
  context.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path === '/__gestalt_live/manual-edit-stash') {
      try {
        const id = request.postDataJSON()?.id;
        if (/^[a-f0-9]{8}$/.test(id ?? ''))
          manualEntryDigest = createHash('sha256').update(id).digest('hex');
      } catch {
        /* No raw body retained. */
      }
    }
    if (request.method() === 'POST' && path === '/__gestalt_live/manual-edit-commit') {
      manualCommitCount++;
      manualCommit = { requestStartedAt: Date.now(), entryDigest: manualEntryDigest };
      emitManualCommitObservation('commit-requested');
    }
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/__gestalt_live/events'
    ) {
      try {
        const kind = request.postDataJSON()?.type;
        if (editKinds.includes(kind)) {
          if (editRequests.length === 16) editRequests.shift();
          editRequests.push({ kind, elapsedMs: Date.now() - browserStarted });
        }
      } catch {
        // Request content is never logged, including malformed bodies and transport tokens.
      }
    }
    const type = request.resourceType();
    resourcePending[type] = (resourcePending[type] ?? 0) + 1;
  });
  const finished = (request) => {
    const type = request.resourceType();
    resourcePending[type] = Math.max(0, (resourcePending[type] ?? 1) - 1);
  };
  context.on('requestfinished', finished);
  context.on('requestfailed', finished);
  context.on('requestfailed', (request) => {
    const code = request.failure()?.errorText;
    if (/^net::ERR_[A-Z0-9_]{1,64}$/.test(code ?? '')) {
      if (networkErrors.length < 16) networkErrors.push(code);
      const resource = request.resourceType();
      if (networkResourceFailures.length < 16) networkResourceFailures.push({ resource, code });
      if (
        stage === 'mobile-navigation' &&
        code === 'net::ERR_NETWORK_CHANGED' &&
        ['script', 'stylesheet'].includes(resource)
      )
        initialMobileAssetsChanged = true;
    }
  });
  context.on('response', async (response) => {
    if (
      new URL(response.url()).pathname === '/__gestalt_live/manual-edit-commit' &&
      response.request().method() === 'POST' &&
      manualCommit
    ) {
      manualCommit.acceptedAt = Date.now();
      manualCommit.status = response.status();
      emitManualCommitObservation('commit-response');
    }
    const resource = `${response.request().resourceType()}:${response.status()}`;
    resourceStatuses[resource] = (resourceStatuses[resource] ?? 0) + 1;
    const url = new URL(response.url());
    if (url.pathname.startsWith('/__gestalt_live/')) {
      const allowed = [
        'live.js',
        'events',
        'status',
        'lease',
        'agent-target-claim',
        'manual-edit-stash',
        'manual-edit-commit',
      ];
      const tail = url.pathname.slice('/__gestalt_live/'.length);
      let headers = {};
      try {
        headers = await response.request().allHeaders();
      } catch {
        // A closed request can make diagnostics unavailable; never log raw headers/errors.
      }
      const requestToken = url.searchParams.get('token');
      if (helperResponses.length === 24) helperResponses.shift();
      const observed = {
        elapsedMs: Date.now() - browserStarted,
        method: ['GET', 'POST'].includes(response.request().method())
          ? response.request().method()
          : 'other',
        route: allowed.includes(tail) ? tail : 'other',
        status: response.status(),
        gatewayHtml: (response.headers()['content-type'] ?? '').startsWith('text/html'),
        helperTokenMatches:
          requestToken === null
            ? null
            : createHash('sha256').update(requestToken).digest('hex') === config.helperTokenSha256,
        cookiePresent: String(headers.cookie ?? '').includes('__Host-gestalt_live_p'),
      };
      if (!firstHelperAuthLoss && [401, 403].includes(observed.status)) {
        firstHelperAuthLoss = { previous: lastAuthenticatedHelper ?? null, first: observed };
        process.stdout.write(JSON.stringify({ firstHelperAuthLoss }) + '\n');
      }
      if (observed.status >= 200 && observed.status < 300 && observed.cookiePresent)
        lastAuthenticatedHelper = observed;
      helperResponses.push(observed);
    }
    if (
      url.origin === config.previewOrigin &&
      ['/__gestalt_live/auth', '/__gestalt_live/exchange', '/'].includes(url.pathname) &&
      exchangeStatuses.length < 16
    )
      exchangeStatuses.push({ path: url.pathname, status: response.status() });
  });
  await context.addInitScript(() => {
    window.__productionHelperConnected = false;
    window.__productionHelperConnectedDocument = null;
    window.__productionHelperHideLiveBar = null;
    const OriginalEventSource = window.EventSource;
    window.EventSource = class extends OriginalEventSource {
      constructor(...args) {
        super(...args);
        const target = new URL(String(args[0]), location.href);
        if (target.origin !== location.origin || target.pathname !== '/__gestalt_live/events')
          return;
        this.addEventListener('message', (event) => {
          try {
            const value = JSON.parse(event.data);
            if (value.type === 'connected') {
              window.__productionHelperConnected = true;
              window.__productionHelperConnectedDocument = performance.timeOrigin;
              window.__productionHelperHideLiveBar = value.hideLiveBar === true;
            } else if (value.type === 'live_bar' && typeof value.hidden === 'boolean') {
              window.__productionHelperHideLiveBar = value.hidden;
            }
          } catch {
            // Ignore non-JSON heartbeat frames.
          }
        });
      }
    };
  });
  // A test-provisioned authorized device/session traverses real production auth.
  // These temporary credentials travel only in this private config, never model input/evidence.
  await context.addCookies([
    {
      name: 'gestalt_mobile_session',
      value: config.sessionCookie,
      domain: 'mobile.entrypoint.test',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    },
  ]);
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 1440, height: 900 });
  checkpoint('mobile-navigation');
  let response;
  let initialMobileGetRetried = false;
  try {
    response = await mobile.goto(config.mobileOrigin + '/');
  } catch (error) {
    if (!String(error?.message ?? '').startsWith('page.goto: net::ERR_NETWORK_CHANGED'))
      throw error;
    initialMobileGetRetried = true;
    // The namespace notifier can settle after Chromium starts. Repeat only
    // this initial read-only GET; no grant, exchange or edit has happened yet.
    await mobile.waitForFunction(
      () => document.documentURI.startsWith('chrome-error://') && document.readyState !== 'loading',
      null,
      { timeout: 5000 },
    );
    checkpoint('mobile-get-after-network-change');
    response = await mobile.goto(config.mobileOrigin + '/');
  }
  // A successful document GET can still lose its initial JS/CSS to the same
  // namespace notifier. Allow one read-only navigation recovery before any
  // controls, grant, Start or edit action; never retry an ambiguous dispatch.
  if (!initialMobileGetRetried && initialMobileAssetsChanged) {
    checkpoint('mobile-get-after-asset-network-change');
    response = await mobile.goto(config.mobileOrigin + '/');
  }
  assert.ok(response.status() < 500);
  assert.equal(await mobile.evaluate(() => isSecureContext), true);
  checkpoint('mobile-controls');
  await mobile.getByRole('button', { name: 'Chat', exact: true }).click();
  await mobile.getByRole('button', { name: 'Live controls', exact: true }).click();
  if (config.startThroughControls) {
    checkpoint('mobile-start');
    assert.equal(config.startObservationBudgetMs, 815_000);
    const startResponse = mobile.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/sessions/${config.sessionId}/live/start` &&
        response.request().method() === 'POST',
      { timeout: config.startObservationBudgetMs },
    );
    await mobile.getByRole('button', { name: 'Start Live', exact: true }).click();
    const result = await startResponse;
    if (result.status() !== 200) {
      const failure = await result.json();
      await writeFile(
        config.resultFile,
        JSON.stringify({
          startStatus: result.status(),
          startCode: /^LIVE_[A-Z_]+$/.test(failure?.code ?? '') ? failure.code : 'UNCLASSIFIED',
        }),
      );
    }
    assert.equal(result.status(), 200);
    const started = await result.json();
    assert.equal(started.state, 'active');
    assert.match(started.liveId, /^[A-Za-z0-9_-]{1,128}$/);
    assert.ok(Number.isSafeInteger(started.generation) && started.generation > 0);
    const origin = new URL(started.previewOrigin);
    assert.equal(origin.protocol, 'https:');
    assert.equal(origin.hostname, 'preview.entrypoint.test');
    const operationId = result.request().postDataJSON().operationId;
    assert.match(operationId, /^[A-Za-z0-9_-]{1,128}$/);
    await mobile.getByRole('button', { name: 'Open preview', exact: true }).waitFor();
    await mobile.screenshot({ path: config.screenshot });
    await writeFile(
      config.resultFile,
      JSON.stringify(
        {
          trustedTls: true,
          ignoreHttpsErrors: false,
          separateBrowserNetwork: true,
          separateBrowserMountNamespace: true,
          startThroughMobileControls: true,
          startObservationBudgetMs: config.startObservationBudgetMs,
          startedRun: {
            liveId: started.liveId,
            generation: started.generation,
            state: started.state,
            previewOrigin: origin.origin,
          },
          operationId,
          productionAuthentication: 'temporary-preprovisioned-authorized-device',
          genuineProvider: false,
        },
        null,
        2,
      ),
    );
    throw new Error('CONTROLS_START_COMPLETE');
  }
  const previewDeadline = Math.min(Date.now() + 60_000, config.observationHostDeadline);
  const grantResponse = mobile.waitForResponse(
    (response) =>
      new URL(response.url()).origin === new URL(config.mobileOrigin).origin &&
      new URL(response.url()).pathname === `/api/sessions/${config.sessionId}/live/launch-grants` &&
      response.request().method() === 'POST',
    { timeout: proofObservationRemaining(previewDeadline) },
  );
  // All observers are armed once before the click; rejected peers remain handled
  // while another exact phase is being observed. No retry mints another grant.
  void grantResponse.catch(() => {});
  const exchangeResponse = context.waitForEvent('response', {
    predicate: (response) =>
      new URL(response.url()).origin === config.previewOrigin &&
      new URL(response.url()).pathname === '/__gestalt_live/exchange',
    timeout: proofObservationRemaining(previewDeadline),
  });
  void exchangeResponse.catch(() => {});
  const popup = mobile.waitForEvent('popup', {
    timeout: proofObservationRemaining(previewDeadline),
  });
  void popup.catch(() => {});
  checkpoint('preview-popup');
  await mobile.getByRole('button', { name: 'Open preview', exact: true }).click({
    timeout: proofObservationRemaining(previewDeadline),
  });
  const preview = await withinProofObservation(() => popup, previewDeadline);
  await preview.setViewportSize({ width: 1440, height: 900 });
  let hmrUpdates = 0;
  preview.on('websocket', (socket) =>
    socket.on('framereceived', (message) => {
      try {
        if (JSON.parse(String(message.payload)).type === 'update') hmrUpdates++;
      } catch {
        /* Ignore non-HMR frames. */
      }
    }),
  );
  checkpoint('preview-exchange');
  const exchangedLease = await observePreviewExchange({
    grantResponse,
    exchangeResponse,
    liveId: config.liveId,
    generation: config.generation,
    previewOrigin: config.previewOrigin,
    deadline: previewDeadline,
    checkpoint,
  });
  checkpoint('preview-navigation');
  try {
    await preview.waitForURL(config.previewOrigin + '/', {
      waitUntil: 'commit',
      timeout: proofObservationRemaining(previewDeadline),
    });
  } catch (error) {
    if (!String(error?.message ?? '').startsWith('page.waitForURL: net::ERR_NETWORK_CHANGED'))
      throw error;
    // The isolated Chromium network notifier can settle after the successful
    // one-use exchange. Repeat only its initial GET, using the same cookie and
    // generation; never repeat the exchange, mint a grant or replay an edit.
    await preview.waitForFunction(
      () => document.documentURI.startsWith('chrome-error://') && document.readyState !== 'loading',
      null,
      { timeout: Math.min(5000, proofObservationRemaining(previewDeadline)) },
    );
    checkpoint('preview-get-after-network-change');
    const recovered = await preview.goto(config.previewOrigin + '/', {
      waitUntil: 'commit',
      timeout: proofObservationRemaining(previewDeadline),
    });
    assert.equal(recovered.status(), 200);
    initialPreviewGetRetried = true;
  }
  checkpoint('opener-confirmation');
  checkpoint('preview-privacy');
  assert.equal(await preview.evaluate(() => location.hash), '');
  assert.equal(await preview.evaluate(() => window.opener), null);
  assert.deepEqual(
    exchangeStatuses.filter((item) => item.path === '/__gestalt_live/exchange'),
    [{ path: '/__gestalt_live/exchange', status: 201 }],
  );
  checkpoint('helper-handshake');
  await ui.waitForHandshake(preview);
  helperBridge = await preview.evaluate(async (expectedHash) => {
    const token = window.__IMPECCABLE_TOKEN__;
    const rawBase = window.__IMPECCABLE_PUBLIC_BASE_URL__;
    const base = typeof rawBase === 'string' ? new URL(rawBase) : null;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
    const actualHash = [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return {
      tokenPresent: typeof token === 'string' && token.length > 0,
      tokenMatches: actualHash === expectedHash,
      sameOrigin: base?.origin === location.origin,
      correctPrefix: base?.pathname === '/__gestalt_live',
    };
  }, config.helperTokenSha256);
  await preview.waitForFunction(() => window.__productionHelperConnected === true);
  checkpoint('app-module-ready');
  await preview.waitForFunction(() => document.body?.dataset.productionHmr === 'original');
  if (config.editingPhase === 'steer')
    await preview
      .getByRole('heading', { name: 'Production chosen variant', exact: true })
      .waitFor();
  checkpoint('helper-connected');
  assert.equal(
    await preview.evaluate(async () => (await fetch('/__gestalt_live/poll')).status),
    403,
  );
  preview.on('framenavigated', (frame) => {
    if (frame === preview.mainFrame()) previewNavigationCount++;
  });
  const observePicker = async (boundary) => {
    let snapshot, timer;
    try {
      snapshot = await Promise.race([
        preview.evaluate(pickerChromeSnapshot),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ available: false }), 1000);
        }),
      ]);
    } catch {
      snapshot = { available: false };
    } finally {
      clearTimeout(timer);
    }
    process.stdout.write(
      JSON.stringify({
        pickerObservation: {
          boundary,
          navigationCount: Math.min(100000, previewNavigationCount),
          ...snapshot,
        },
      }) + '\n',
    );
  };
  const actions = new Set();
  let manualLease;
  const manualLeaseStages = new Set();
  const readPreviewCookie = async () =>
    previewCookieObservation(await context.cookies(config.previewOrigin), config.previewOrigin);
  const requireManualCapacity = async (boundary) => {
    const cookie = await readPreviewCookie();
    const deadline = manualLeaseDeadline({
      cookie,
      lease: manualLease.lease,
      generation: config.generation,
      hostDeadline: config.observationHostDeadline,
      requiredMs: manualLeaseEstimate[boundary],
    });
    manualLease.capacityObservations.push({
      boundary,
      sampledAt: Date.now(),
      cookieExpiresAt: cookie.cookieExpiresAt,
      deadline,
      estimateMs: manualLeaseEstimate[boundary],
      discardCostIsProxy: true,
    });
    return deadline;
  };
  const runManualSequence = (steps, deadline, boundary) =>
    ownedProofSequence({
      steps,
      deadline,
      abort: () => context.close(),
      observe: (observation) =>
        process.stdout.write(
          JSON.stringify({
            manualSequenceObservation: { boundary, ...observation },
          }) + '\n',
        ),
    });
  const observeManualLeaseStage = async (leaseStage) => {
    assert.equal(manualLeaseStages.has(leaseStage), false);
    manualLeaseStages.add(leaseStage);
    const cookie = await readPreviewCookie();
    const previous = manualLease;
    const current = await renewManualPreviewLease({
      cookie,
      stage: leaseStage,
      generation: config.generation,
      hostDeadline: config.observationHostDeadline,
      requiredMs: manualLeaseEstimate[leaseStage === 'before-generate' ? 'generate' : 'discard'],
      renew: (actual, deadline) =>
        command(`manual-lease-${leaseStage}`, deadline, {
          cookie: actual,
          startedAt: Date.now(),
          hostDeadline: config.observationHostDeadline,
        }),
      redeliver: () =>
        preview.evaluate(async () => {
          const response = await fetch('/__gestalt_live/lease', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (response.status !== 200) throw new Error('PROOF_MANUAL_LEASE_REDELIVERY');
          return response.json();
        }),
      readCookie: readPreviewCookie,
    });
    manualLease = {
      ...current,
      capacityObservations: previous?.capacityObservations ?? [],
      stages: [...(previous?.stages ?? []), current.lease],
    };
  };
  const generate = async (label) => {
    const deadline = manualLease ? await requireManualCapacity('generate') : undefined;
    checkpoint('picker-generate');
    const steps = [
      () => ui.pickElement(preview, 'h1.hero-title', { resetPickMode: true }),
      () => ui.setCount(preview, 2),
      () => ui.clickGo(preview),
      () =>
        ui.waitForCycling(preview, 2, {
          timeout: deadline
            ? Math.min(modelEffectTimeout, proofObservationRemaining(deadline))
            : modelEffectTimeout,
        }),
      () =>
        preview.getByRole('heading', { name: label, exact: true }).waitFor({
          timeout: deadline ? proofObservationRemaining(deadline) : modelEffectTimeout,
        }),
    ];
    if (deadline) await runManualSequence(steps, deadline, 'generate');
    else for (const step of steps) await step();
    actions.add('generate');
  };
  let acceptContinuity, resumedSteerDeadline;
  const accept = async () => {
    // Starts BEFORE the first Accept observation/click, never reset by acknowledgement/navigation.
    const acceptDeadline = Math.min(
      Date.now() + terminalEffectTimeout,
      config.observationHostDeadline,
    );
    await observePicker('before-accept');
    await withinProofObservation(
      () => ui.clickAccept(preview, { expectedVariant: 1 }),
      acceptDeadline,
    );
    await withinProofObservation(
      () => ui.waitForBarHidden(preview, { timeout: Math.max(1, acceptDeadline - Date.now()) }),
      acceptDeadline,
    );
    await observePicker('after-accept');
    await command('accepted', acceptDeadline);
    await observePicker('after-accept-ack');
    if (!config.pickerSmoke && config.editingPhase !== 'accepted')
      acceptContinuity = await observePickerContinuity(preview, {
        deadline: acceptDeadline,
        heading: 'Production chosen variant',
      });
    actions.add('accept');
  };
  const steer = async () => {
    checkpoint('picker-steer');
    await observePicker('before-steer');
    const submit = async (deadline) => {
      resumedSteerDeadline = deadline;
      if (resumedSteerDeadline)
        assert.ok(
          proofObservationRemaining(resumedSteerDeadline) >= 180_000,
          'PROOF_EDIT_BUDGET_INSUFFICIENT',
        );
      await ui.submitSteer(preview, 'production steer: update the HMR marker');
      await preview.waitForFunction(() => document.body.dataset.productionHmr === 'steered', null, {
        timeout: resumedSteerDeadline
          ? Math.min(modelEffectTimeout, proofObservationRemaining(resumedSteerDeadline))
          : modelEffectTimeout,
      });
      await ui.waitForSteerUnlocked(preview, {
        timeout: resumedSteerDeadline
          ? Math.min(modelEffectTimeout, proofObservationRemaining(resumedSteerDeadline))
          : modelEffectTimeout,
      });
      assert.ok(hmrUpdates > 0);
      await command('steered', resumedSteerDeadline);
      actions.add('steer');
    };
    if (config.editingPhase !== 'steer') return submit();
    return observeEditingSteer({
      generation: config.generation,
      hostDeadline: config.observationHostDeadline,
      observeContinuity: async () => {
        acceptContinuity = await observePickerContinuity(preview, {
          deadline: Math.min(Date.now() + 30_000, config.observationHostDeadline - 195_000),
          heading: 'Production chosen variant',
        });
      },
      readLease: () =>
        preview.evaluate(async (generation) => {
          const response = await fetch('/__gestalt_live/lease', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          if (response.status !== 200) return null;
          const lease = await response.json();
          return {
            generation,
            leaseExpiresAt: lease.leaseExpiresAt,
            absoluteExpiresAt: lease.absoluteExpiresAt,
          };
        }, exchangedLease.generation),
      submit,
    });
  };
  const manual = async () => {
    checkpoint('picker-manual-apply');
    const manualObservationStartedAt = Date.now();
    const manualObservation = {
      startedAt: manualObservationStartedAt,
      hostDeadline: config.observationHostDeadline,
    };
    const pollDeadline = manualObservationDeadline(manualObservation);
    const dispatched = await command('manual-poll-observed', pollDeadline, manualObservation);
    assert.equal(dispatched.commandIpcDispatched, true);
    assert.equal(dispatched.workerBirthsCurrent, true);
    assert.equal(dispatched.pending, true);
    await ui.pickElement(preview, 'h1.hero-title', { resetPickMode: true });
    await ui.clickEditCopy(preview);
    await ui.editTextLeaf(preview, 'h1.hero-title', 'Production manual approved');
    await ui.clickSaveEdit(preview);
    await ui.assertApplyDockVisible(preview, 1, { timeout: 60_000 });
    await command('manual-commit-observed', pollDeadline, manualObservation);
    const manualDeadline = Date.now() + 120_000;
    manualCommitDeadline = manualDeadline;
    await withinProofObservation(() => ui.clickApplyEdits(preview), manualDeadline);
    await withinProofObservation(async () => {
      while (manualCommit?.acceptedAt === undefined)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25, proofObservationRemaining(manualDeadline))),
        );
    }, manualDeadline);
    assert.equal(manualCommitCount, 1);
    assert.equal(manualCommit?.status, 202);
    await withinProofObservation(
      () =>
        ui.waitForApplyDockHidden(preview, { timeout: Math.max(1, manualDeadline - Date.now()) }),
      manualDeadline,
    );
    const { requestStartedAt, acceptedAt, entryDigest } = manualCommit;
    emitManualCommitObservation('before-canonical-ack');
    await command('manual-applied', manualDeadline, {
      manual: { requestStartedAt, acceptedAt, entryDigest },
    });
    emitManualCommitObservation('canonical-acknowledged');
    actions.add('manual');
  };
  const discard = async () => {
    checkpoint('picker-discard');
    await generate('Production discarded variant');
    if (manualLease) await observeManualLeaseStage('before-discard');
    const deadline = manualLease ? await requireManualCapacity('discard') : undefined;
    const steps = [
      () => ui.clickDiscard(preview),
      () =>
        ui.waitForBarHidden(preview, {
          timeout: deadline
            ? Math.min(terminalEffectTimeout, proofObservationRemaining(deadline))
            : terminalEffectTimeout,
        }),
      () => command('discarded', deadline),
    ];
    if (deadline) await runManualSequence(steps, deadline, 'discard');
    else for (const step of steps) await step();
    assert.equal(
      await preview
        .getByRole('heading', { name: 'Production manual approved', exact: true })
        .count(),
      1,
    );
    actions.add('discard');
  };
  const background = async () => {
    checkpoint('background-beyond-eight-seconds');
    await command('background-begin');
    const foreground = await context.newPage();
    await foreground.bringToFront();
    await preview.waitForFunction(() => document.visibilityState === 'hidden', undefined, {
      polling: 100,
      timeout: 5000,
    });
    const hiddenAt = Date.now();
    await new Promise((done) => setTimeout(done, 9200));
    assert.equal(await preview.evaluate(() => document.visibilityState), 'hidden');
    assert.ok(Date.now() - hiddenAt > 8000);
    await preview.bringToFront();
    await preview.waitForFunction(() => document.visibilityState === 'visible');
    await foreground.close();
    await command('background-finished');
    actions.add('background');
  };
  assert.ok(['', 'accept-steer', 'manual-discard'].includes(config.proofLane ?? ''));
  if (config.proofLane === 'manual-discard') {
    await manual();
    checkpoint('manual-before-generate-lease');
    await observeManualLeaseStage('before-generate');
    await discard();
  } else if (config.editingPhase === 'steer') {
    assert.equal(config.proofLane, 'accept-steer');
    assert.ok(
      config.observationHostDeadline - Date.now() >= 195_000,
      'PROOF_EDIT_BUDGET_INSUFFICIENT',
    );
    await steer();
    await background();
  } else {
    await generate('Production chosen variant');
    await accept();
    if (!config.pickerSmoke && config.editingPhase !== 'accepted') {
      await steer();
      if (config.proofLane !== 'accept-steer') {
        await manual();
        await discard();
      }
      await background();
    }
  }
  await preview.screenshot({ path: config.screenshot });
  let postAcceptPollObservation;
  let postSteerPollObservation;
  let postDiscardPollObservation;
  if (config.proofLane === 'manual-discard') {
    assert.ok(actions.has('discard'));
    checkpoint('post-discard-poll-dispatch');
    const deadline = await requireManualCapacity('post-discard');
    postDiscardPollObservation = await command('discarded-poll-observed', deadline, {
      hostDeadline: config.observationHostDeadline,
    });
    assert.equal(postDiscardPollObservation.commandIpcDispatched, true);
    assert.equal(postDiscardPollObservation.postAuthority, true);
    assert.equal(postDiscardPollObservation.pending, true);
  }
  if (['accepted', 'steer'].includes(config.editingPhase)) {
    // Keep the real preview/SSE alive until the next owning poll has actually
    // dispatched after authority validation. This read cannot reset phase A.
    const phaseA = config.editingPhase === 'accepted';
    if (!phaseA) assert.ok(actions.has('steer') && actions.has('background'));
    checkpoint(phaseA ? 'post-accept-poll-dispatch' : 'post-steer-poll-dispatch');
    const deadline = Math.min(Date.now() + 300_000, config.observationHostDeadline);
    const observed = await command(
      phaseA ? 'accepted-poll-observed' : 'steered-poll-observed',
      deadline,
      {
        hostDeadline: config.observationHostDeadline,
      },
    );
    assert.equal(observed.commandIpcDispatched, true);
    assert.equal(observed.postAuthority, true);
    assert.equal(observed.pending, true);
    if (phaseA) postAcceptPollObservation = observed;
    else postSteerPollObservation = observed;
  }
  await writeFile(
    config.resultFile,
    JSON.stringify(
      {
        trustedTls: true,
        ignoreHttpsErrors: false,
        separateBrowserNetwork: true,
        separateBrowserMountNamespace: true,
        openThroughMobileControls: true,
        realPickerGenerateAccept: actions.has('generate') && actions.has('accept'),
        acceptContinuity: config.editingPhase ? undefined : acceptContinuity,
        postResumeContinuity: config.editingPhase === 'steer' ? acceptContinuity : undefined,
        proofLane: config.proofLane || undefined,
        editingPhase: config.editingPhase,
        postAcceptPollObservation,
        postSteerPollObservation,
        postDiscardPollObservation,
        manualLease,
        firstHelperAuthLoss,
        observedGeneration: config.generation,
        pickerSmoke: config.pickerSmoke === true,
        realPickerSteer: actions.has('steer'),
        realPickerManualApply: actions.has('manual'),
        realPickerDiscard: actions.has('discard'),
        actualTabHiddenBeyondEightSeconds: actions.has('background'),
        playwrightFocusOverrideDisabled: true,
        hmrUpdates,
        extraPollOwnerDenied: true,
        initialPreviewGetRetried,
        exchangePosts: exchangeStatuses.filter((item) => item.path === '/__gestalt_live/exchange')
          .length,
        productionAuthentication: 'temporary-preprovisioned-authorized-device',
        genuineProvider: false,
      },
      null,
      2,
    ),
  );
  checkpoint('complete');
} catch (error) {
  if (config.startThroughControls && error?.message === 'CONTROLS_START_COMPLETE') {
    checkpoint('controls-start-complete');
  } else if (config.preflight && error?.message === 'BROWSER_PREFLIGHT_COMPLETE') {
    checkpoint('preflight-complete');
  } else {
    const callsite = /live-production-edit-browser\.mjs:(\d+):(\d+)/.exec(error?.stack ?? '');
    process.stdout.write(
      JSON.stringify({
        failure: {
          stage,
          code: ['ERR_ASSERTION', 'ENOENT', 'EACCES', 'ERR_MODULE_NOT_FOUND'].includes(error?.code)
            ? error.code
            : error?.name === 'TimeoutError'
              ? 'TIMEOUT'
              : 'BROWSER_OPERATION_FAILED',
          callsite: callsite ? { line: Number(callsite[1]), column: Number(callsite[2]) } : null,
          diagnostic: safeBrowserFailure(error?.message),
          markers: [
            'Execution context was destroyed',
            'Target page, context or browser has been closed',
            'Navigation failed',
            'interrupted',
            'Timeout',
            'TypeError',
            'JSON',
          ].filter((marker) => String(error?.message ?? '').includes(marker)),
          chromeStartup: {
            exitCode: browserProcess?.exitCode,
            signal: browserProcess?.signalCode,
            markers: [...chromeStartupMarkers],
            components: chromeComponents,
            checks: chromeChecks,
            baselineSandboxedLaunch,
            launcherKernel,
          },
          networkErrors,
          networkResourceFailures,
          exchangeStatuses,
          resourcePending,
          resourceStatuses,
          pageErrors,
          helperBridge,
          helperResponses,
          firstHelperAuthLoss,
          editRequests,
        },
      }) + '\n',
    );
    process.stderr.write(`EDIT_BROWSER_FAILED_${stage.replaceAll('-', '_')}\n`);
    process.exitCode = 1;
  }
} finally {
  emitManualCommitObservation('browser-finally');
  await browser?.close();
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    browserProcess.kill('SIGTERM');
    let timer;
    try {
      await Promise.race([
        browserExit,
        new Promise((done) => {
          timer = setTimeout(done, 5000);
        }),
      ]);
      if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
        browserProcess.kill('SIGKILL');
        await browserExit;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  process.stdin.destroy();
}
