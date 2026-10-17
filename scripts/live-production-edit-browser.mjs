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
import { safeBrowserFailure } from './live-production-edit-diagnostics.mjs';

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
const exchangeStatuses = [];
const resourcePending = {};
const resourceStatuses = {};
const pageErrors = [];
const helperResponses = [];
const editRequests = [];
const editKinds = ['generate', 'steer', 'accept', 'discard', 'manual_edit_apply'];
// A measured source/selection/catalog/provenance/resource authority check takes
//111s before turn/start. Observe both authority/helper windows without changing
// the upstream595s lease, source checks, replay rules or any product deadline.
if (!config.preflight && !config.startThroughControls)
  assert.equal(config.eventObservationBudgetMs, 300_000);
const modelEffectTimeout = config.eventObservationBudgetMs ?? 90_000;
const terminalEffectTimeout = config.eventObservationBudgetMs ?? 60_000;
let helperBridge;
const browserStarted = Date.now();
let initialPreviewGetRetried = false;
const checkpoint = (value) => {
  stage = value;
  process.stdout.write(
    JSON.stringify({ checkpoint: value, elapsedMs: Date.now() - browserStarted }) + '\n',
  );
};
const replies = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function command(value) {
  process.stdout.write(JSON.stringify({ command: value }) + '\n');
  const reply = await replies.next();
  assert.equal(JSON.parse(reply.value).ok, true);
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
    if (/^net::ERR_[A-Z0-9_]{1,64}$/.test(code ?? '') && networkErrors.length < 16)
      networkErrors.push(code);
  });
  context.on('response', async (response) => {
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
      helperResponses.push({
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
      });
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
    const OriginalEventSource = window.EventSource;
    window.EventSource = class extends OriginalEventSource {
      constructor(...args) {
        super(...args);
        const target = new URL(String(args[0]), location.href);
        if (target.origin !== location.origin || target.pathname !== '/__gestalt_live/events')
          return;
        this.addEventListener('message', (event) => {
          try {
            if (JSON.parse(event.data).type === 'connected')
              window.__productionHelperConnected = true;
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
  try {
    response = await mobile.goto(config.mobileOrigin + '/');
  } catch (error) {
    if (!String(error?.message ?? '').startsWith('page.goto: net::ERR_NETWORK_CHANGED'))
      throw error;
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
  const exchangeResponse = context.waitForEvent('response', {
    predicate: (response) =>
      new URL(response.url()).origin === config.previewOrigin &&
      new URL(response.url()).pathname === '/__gestalt_live/exchange',
    timeout: 60000,
  });
  const popup = mobile.waitForEvent('popup');
  checkpoint('preview-popup');
  await mobile.getByRole('button', { name: 'Open preview', exact: true }).click();
  const preview = await popup;
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
  assert.equal((await exchangeResponse).status(), 201);
  try {
    await preview.waitForURL(config.previewOrigin + '/', { waitUntil: 'commit' });
  } catch (error) {
    if (!String(error?.message ?? '').startsWith('page.waitForURL: net::ERR_NETWORK_CHANGED'))
      throw error;
    // The isolated Chromium network notifier can settle after the successful
    // one-use exchange. Repeat only its initial GET, using the same cookie and
    // generation; never repeat the exchange, mint a grant or replay an edit.
    await preview.waitForFunction(
      () => document.documentURI.startsWith('chrome-error://') && document.readyState !== 'loading',
      null,
      { timeout: 5000 },
    );
    checkpoint('preview-get-after-network-change');
    const recovered = await preview.goto(config.previewOrigin + '/', { waitUntil: 'commit' });
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
  checkpoint('helper-connected');
  assert.equal(
    await preview.evaluate(async () => (await fetch('/__gestalt_live/poll')).status),
    403,
  );
  checkpoint('picker-generate');
  await ui.pickElement(preview, 'h1.hero-title', { resetPickMode: true });
  await ui.setCount(preview, 2);
  await ui.clickGo(preview);
  await ui.waitForCycling(preview, 2, { timeout: modelEffectTimeout });
  await preview.getByRole('heading', { name: 'Production chosen variant', exact: true }).waitFor();
  await ui.clickAccept(preview, { expectedVariant: 1 });
  await ui.waitForBarHidden(preview, { timeout: terminalEffectTimeout });
  await command('accepted');
  checkpoint('picker-steer');
  await ui.submitSteer(preview, 'production steer: update the HMR marker');
  await preview.waitForFunction(() => document.body.dataset.productionHmr === 'steered', null, {
    timeout: modelEffectTimeout,
  });
  await ui.waitForSteerUnlocked(preview, { timeout: modelEffectTimeout });
  assert.ok(hmrUpdates > 0);
  await command('steered');
  checkpoint('picker-manual-apply');
  await ui.pickElement(preview, 'h1.hero-title', { resetPickMode: true });
  await ui.clickEditCopy(preview);
  await ui.editTextLeaf(preview, 'h1.hero-title', 'Production manual approved');
  await ui.clickSaveEdit(preview);
  await ui.assertApplyDockVisible(preview, 1, { timeout: 60_000 });
  await ui.clickApplyEdits(preview);
  await ui.waitForApplyDockHidden(preview, { timeout: modelEffectTimeout });
  await command('manual-applied');
  checkpoint('picker-discard');
  await ui.pickElement(preview, 'h1.hero-title', { resetPickMode: true });
  await ui.setCount(preview, 2);
  await ui.clickGo(preview);
  await ui.waitForCycling(preview, 2, { timeout: modelEffectTimeout });
  await preview
    .getByRole('heading', { name: 'Production discarded variant', exact: true })
    .waitFor();
  await ui.clickDiscard(preview);
  await ui.waitForBarHidden(preview, { timeout: terminalEffectTimeout });
  await command('discarded');
  assert.equal(
    await preview.getByRole('heading', { name: 'Production manual approved', exact: true }).count(),
    1,
  );
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
  await preview.screenshot({ path: config.screenshot });
  await writeFile(
    config.resultFile,
    JSON.stringify(
      {
        trustedTls: true,
        ignoreHttpsErrors: false,
        separateBrowserNetwork: true,
        separateBrowserMountNamespace: true,
        openThroughMobileControls: true,
        realPickerGenerateAccept: true,
        realPickerSteer: true,
        realPickerManualApply: true,
        realPickerDiscard: true,
        actualTabHiddenBeyondEightSeconds: true,
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
          exchangeStatuses,
          resourcePending,
          resourceStatuses,
          pageErrors,
          helperBridge,
          helperResponses,
          editRequests,
        },
      }) + '\n',
    );
    process.stderr.write(`EDIT_BROWSER_FAILED_${stage.replaceAll('-', '_')}\n`);
    process.exitCode = 1;
  }
} finally {
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
