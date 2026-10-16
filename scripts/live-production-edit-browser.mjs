/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { safeBrowserFailure } from './live-production-edit-diagnostics.mjs';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
let stage = 'start';
let browser;
const networkErrors = [];
const exchangeStatuses = [];
const resourcePending = {};
const resourceStatuses = {};
const pageErrors = [];
const helperResponses = [];
const editRequests = [];
const editKinds = ['generate', 'steer', 'accept', 'discard', 'manual_edit_apply'];
// Real Native admission precedes every model effect. The measured generate took
// 56s; steer was still durably dispatched at the old30s fixture deadline.
// These observation waits do not change the helper lease or any product deadline.
const modelEffectTimeout = 90000;
const terminalEffectTimeout = 60000;
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
  checkpoint('ui-import');
  const ui = await import(pathToFileURL(config.uiModule).href);
  checkpoint('browser-launch');
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    env: {
      ...process.env,
      HOME: config.browserHome,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
    },
    args: [
      `--host-resolver-rules=MAP *.preview.entrypoint.test ${config.hostAddress}, MAP preview.entrypoint.test ${config.hostAddress}, MAP mobile.entrypoint.test ${config.hostAddress}`,
      '--no-proxy-server',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
      const allowed = ['live.js', 'events', 'status', 'lease', 'agent-target-claim'];
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
  checkpoint('launch-grant');
  await mobile.evaluate(async ({ sessionId, liveId, generation, previewOrigin }) => {
    const encode = (bytes) =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    const verifier = encode(random);
    const codeChallenge = encode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    const result = await fetch(`/api/sessions/${sessionId}/live/launch-grants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ liveId, generation, codeChallenge, codeChallengeMethod: 'S256' }),
    });
    if (result.status !== 201) throw Error('EDIT_LAUNCH_GRANT_REFUSED');
    const grant = await result.json();
    const button = document.createElement('button');
    button.id = 'production-proof-launch';
    button.textContent = 'Open preview';
    document.body.append(button);
    button.onclick = () => {
      const peer = window.open(grant.exchangeUrl, 'production-edit-preview');
      const receive = (event) => {
        if (
          event.source !== peer ||
          event.origin !== previewOrigin ||
          event.data?.grantId !== grant.grantId
        )
          return;
        if (event.data.type === 'gestalt-live-proof')
          peer.postMessage(
            { type: 'gestalt-live-proof', grantId: grant.grantId, codeVerifier: verifier },
            previewOrigin,
          );
        if (event.data.type === 'gestalt-live-exchanged') {
          window.__editExchanged = true;
          window.removeEventListener('message', receive);
        }
      };
      window.addEventListener('message', receive);
    };
  }, config);
  const popup = mobile.waitForEvent('popup');
  checkpoint('preview-popup');
  await mobile.locator('#production-proof-launch').click();
  const preview = await popup;
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
  try {
    await preview.waitForURL(config.previewOrigin + '/', { waitUntil: 'commit' });
  } catch (error) {
    if (!String(error?.message ?? '').startsWith('page.waitForURL: net::ERR_NETWORK_CHANGED'))
      throw error;
    // The isolated Chromium network notifier can settle after the successful
    // one-use exchange. Repeat only its initial GET, using the same cookie and
    // generation; never repeat the exchange, mint a grant or replay an edit.
    await mobile.waitForFunction(() => window.__editExchanged === true, null, {
      timeout: 10000,
    });
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
  await mobile.waitForFunction(() => window.__editExchanged === true);
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
  await ui.assertApplyDockVisible(preview, 1);
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
  await preview.screenshot({ path: config.screenshot });
  await writeFile(
    config.resultFile,
    JSON.stringify(
      {
        trustedTls: true,
        ignoreHttpsErrors: false,
        separateBrowserNetwork: true,
        realPickerGenerateAccept: true,
        realPickerSteer: true,
        realPickerManualApply: true,
        realPickerDiscard: true,
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
} finally {
  await browser?.close();
  process.stdin.destroy();
}
