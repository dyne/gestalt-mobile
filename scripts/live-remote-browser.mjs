/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Runs as the ordinary runner user inside the disposable browser network namespace.
import assert from 'node:assert/strict';
import { readFile, readlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.notEqual(await readlink('/proc/self/ns/net'), config.serverNetwork);
assert.equal(await readlink('/proc/self/ns/net'), config.browserNetwork);
const ui = await import(pathToFileURL(config.uiModule).href);
const commands = createInterface({ input: process.stdin });
const replies = commands[Symbol.asyncIterator]();
async function command(value) {
  process.stdout.write(`${JSON.stringify({ command: value })}\n`);
  const reply = await replies.next();
  const parsed = JSON.parse(reply.value);
  assert.equal(parsed.ok, true, `Controller proof command ${value} failed`);
  return parsed;
}
async function privateTargetDenied(host, port) {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1000, () => {
      socket.destroy();
      done(false);
    });
  });
}
const privateTargetProbes = await Promise.all(
  ['127.0.0.1', config.hostAddress].flatMap((host) =>
    [config.helperPort, config.secondHelperPort].map(async (port) => ({
      host,
      port,
      denied: await privateTargetDenied(host, port),
    })),
  ),
);
const helperLoopbackDenied = privateTargetProbes.every((probe) => probe.denied);
assert.equal(helperLoopbackDenied, true);
const destinations = new Set();
const anonymous = [];
const errors = [];
const browser = await chromium.launch({
  headless: true,
  chromiumSandbox: true,
  env: { ...process.env, HOME: config.browserHome, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
  args: [
    `--host-resolver-rules=MAP preview.live.test ${config.hostAddress}, MAP mobile.live.test ${config.hostAddress}`,
    '--no-proxy-server',
  ],
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.__liveProofEvents = [];
    window.__liveProofSseErrors = 0;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          try {
            window.__liveProofEvents.push(JSON.parse(event.data).type);
          } catch {
            /* Non-JSON heartbeat. */
          }
        });
        this.addEventListener('error', () => {
          window.__liveProofSseErrors++;
        });
      }
    };
  });
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
      destinations.add(`${url.protocol}//${url.host}${url.pathname}`);
  });
  const mobile = await context.newPage();
  const cdp = await context.newCDPSession(mobile);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  // Certificate validation is enabled. The sole test root was imported into this temporary HOME's NSS DB.
  const mobileResponse = await mobile.goto(config.mobileOrigin);
  assert.equal(mobileResponse.status(), 200);
  assert.equal(await mobile.evaluate(() => isSecureContext), true);
  const authentication = await mobile.evaluate(async () => {
    const optionsResponse = await fetch('/api/auth/register/options', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!optionsResponse.ok) throw new Error(`Passkey options ${optionsResponse.status}`);
    const { options } = await optionsResponse.json();
    const credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
    });
    const response = await fetch('/api/auth/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: credential.toJSON(), nickname: 'Separate network browser' }),
    });
    return { status: response.status, result: await response.json() };
  });
  assert.equal(authentication.status, 201, JSON.stringify(authentication.result));
  assert.equal(authentication.result.status, 'authenticated');
  // A real opener supplies a one-use PKCE verifier only to the validated preview window/origin.
  async function prepareLaunch(previewOrigin, relayId, liveId) {
    await mobile.evaluate(
      async ({ previewOrigin, relayId, liveId }) => {
        window.__proofExchanged = false;
        const token = new Uint8Array(32);
        crypto.getRandomValues(token);
        const encode = (bytes) =>
          btoa(String.fromCharCode(...bytes))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replaceAll('=', '');
        const verifier = encode(token);
        const challenge = encode(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
        );
        const response = await fetch(`/api/sessions/${relayId}/live/launch-grants`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            liveId,
            generation: 1,
            codeChallenge: challenge,
            codeChallengeMethod: 'S256',
          }),
        });
        if (!response.ok) throw new Error(`Launch grant ${response.status}`);
        const grant = await response.json();
        const button = document.getElementById('launch');
        button.onclick = () => {
          const peer = window.open(grant.exchangeUrl, `live-${relayId}`);
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
              window.__proofExchanged = true;
              window.removeEventListener('message', receive);
            }
          };
          window.addEventListener('message', receive);
        };
      },
      { previewOrigin, relayId, liveId },
    );
  }
  await prepareLaunch(config.previewOrigin, 'remote-proof', 'real-helper');
  const popupPromise = mobile.waitForEvent('popup');
  await mobile.locator('#launch').click();
  const preview = await popupPromise;
  let hmrOpened = false;
  let hmrUpdates = 0;
  let hmrClosed = false;
  let crossPortProbe = false;
  preview.on('websocket', (socket) => {
    const url = new URL(socket.url());
    destinations.add(`${url.protocol}//${url.host}${url.pathname}`);
    if (crossPortProbe && url.origin === config.secondPreviewOrigin.replace('https:', 'wss:'))
      return;
    assert.equal(url.origin, config.previewOrigin.replace('https:', 'wss:'));
    socket.on('framereceived', (event) => {
      const message = JSON.parse(String(event.payload));
      if (message.type === 'connected') {
        hmrOpened = true;
        hmrClosed = false;
      }
      if (message.type === 'update') hmrUpdates++;
    });
    socket.on('close', () => {
      hmrClosed = true;
    });
  });
  preview.on('pageerror', (error) => errors.push(error.message));
  await preview.waitForURL(`${config.previewOrigin}/`);
  await mobile.waitForFunction(() => window.__proofExchanged === true);
  assert.equal(await preview.evaluate(() => location.hash), '');
  assert.equal(await preview.evaluate(() => window.opener), null);
  assert.equal(await preview.evaluate(() => isSecureContext), true);
  await ui.waitForHandshake(preview);
  await preview.waitForFunction(() => window.__liveProofEvents.includes('connected'));
  assert.equal(
    await preview.evaluate(() => window.__IMPECCABLE_PUBLIC_BASE_URL__),
    `${config.previewOrigin}/__gestalt_live`,
  );
  const cookies = await context.cookies();
  assert.equal(
    cookies
      .filter((cookie) => cookie.name === 'gestalt_mobile_session')
      .every((cookie) => cookie.domain === 'mobile.live.test'),
    true,
  );
  assert.equal(
    cookies
      .filter((cookie) => cookie.name.startsWith('__Host-gestalt_live_'))
      .every((cookie) => cookie.domain === 'preview.live.test' && cookie.secure && cookie.httpOnly),
    true,
  );
  await ui.assertBottomBarIdle(preview);
  const detectLoaded = preview.waitForResponse(
    (response) => new URL(response.url()).pathname === '/__gestalt_live/detect.js',
  );
  await preview.evaluate(() =>
    window.__impeccableLiveQuery('#impeccable-live-detect-toggle').click(),
  );
  assert.equal((await detectLoaded).status(), 200);
  await preview.waitForFunction(() =>
    Boolean(window.__impeccableLiveQuery('#impeccable-live-detect-toggle')),
  );
  const lazyAssets = await preview.evaluate(async () => {
    const base = window.__IMPECCABLE_PUBLIC_BASE_URL__;
    const result = await fetch(`${base}/modern-screenshot.js`);
    const missingHelperToken = await fetch(`${base}/status`);
    return { screenshotAsset: result.status, missingHelperToken: missingHelperToken.status };
  });
  assert.equal(lazyAssets.screenshotAsset, 200);
  assert.equal(lazyAssets.missingHelperToken, 401);
  await ui.pickElement(preview, 'h1.hero-title');
  await ui.clickGo(preview);
  await command('helper-reply');
  await preview.waitForFunction(() => window.__liveProofEvents.includes('error'));
  // Actual source edit produces an actual Vite HMR frame through the authenticated WSS gateway.
  await command('hmr');
  await preview.getByRole('heading', { name: 'Remote HMR verified' }).waitFor();
  assert.equal(hmrOpened, true);
  assert.ok(hmrUpdates > 0);
  const responseHeaders = await (await preview.reload()).allHeaders();
  assert.equal(responseHeaders['cross-origin-resource-policy'], 'same-origin');
  assert.ok(responseHeaders['content-security-policy'].includes("frame-ancestors 'none'"));
  await ui.waitForHandshake(preview);
  await preview.waitForFunction(() => window.__liveProofEvents.includes('connected'));
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await preview.setViewportSize(viewport);
    assert.equal(
      await preview.evaluate(() => getComputedStyle(document.documentElement).fontSize),
      '16px',
    );
    await preview.screenshot({
      path: `${config.evidence}/remote-preview-authenticated-${viewport.width}x${viewport.height}.png`,
    });
  }
  // Two actual admitted apps/ports and two valid ambient cookies in the same browser.
  await prepareLaunch(config.secondPreviewOrigin, 'second-remote-proof', 'second-real-helper');
  const secondPopupPromise = mobile.waitForEvent('popup');
  await mobile.locator('#launch').click();
  const secondPreview = await secondPopupPromise;
  await secondPreview.waitForURL(`${config.secondPreviewOrigin}/`);
  await ui.waitForHandshake(secondPreview);
  await secondPreview.waitForFunction(() => window.__liveProofEvents.includes('connected'));
  assert.equal(
    await secondPreview.evaluate(async () => (await fetch('/cross-port-canary.js')).status),
    200,
  );
  const leaseCookies = (await context.cookies()).filter((cookie) =>
    cookie.name.startsWith('__Host-gestalt_live_'),
  );
  assert.equal(leaseCookies.length, 2);
  crossPortProbe = true;
  const crossPortBlocked = await preview.evaluate(async (origin) => {
    const script = document.createElement('script');
    script.src = `${origin}/cross-port-canary.js`;
    const image = document.createElement('img');
    image.src = `${origin}/cross-port-canary.svg`;
    const iframe = document.createElement('iframe');
    iframe.src = `${origin}/`;
    const scriptBlocked = new Promise((done) => {
      script.onload = () => done(false);
      script.onerror = () => done(true);
    });
    const imageBlocked = new Promise((done) => {
      image.onload = () => done(false);
      image.onerror = () => done(true);
    });
    document.body.append(script, image, iframe);
    const wsBlocked = new Promise((done) => {
      const peer = new WebSocket(origin.replace('https:', 'wss:'), 'vite-hmr');
      peer.onopen = () => {
        peer.close();
        done(false);
      };
      peer.onerror = () => done(true);
    });
    const [scriptDenied, imageDenied, websocketDenied] = await Promise.all([
      scriptBlocked,
      imageBlocked,
      wsBlocked,
    ]);
    const scriptExecuted = window.__crossPortScriptLoaded === true;
    return { scriptDenied, imageDenied, websocketDenied, scriptExecuted };
  }, config.secondPreviewOrigin);
  assert.deepEqual(crossPortBlocked, {
    scriptDenied: true,
    imageDenied: true,
    websocketDenied: true,
    scriptExecuted: false,
  });
  await preview.waitForTimeout(300);
  const crossPortResponses = (await command('cross-port-evidence')).observations;
  for (const [path, destination] of [
    ['/cross-port-canary.js', 'script'],
    ['/cross-port-canary.svg', 'image'],
    ['/', 'iframe'],
  ]) {
    const response = crossPortResponses.find(
      (entry) => entry.path === path && entry.status === 403 && entry.secFetchDest === destination,
    );
    assert.ok(response, `Missing actual gateway cross-port 403 ${path}`);
    assert.equal(response.secFetchSite, 'same-site');
    assert.ok(
      leaseCookies.every((cookie) => response.cookieNames.includes(cookie.name)),
      'Both valid leases must be ambient on the denied cross-port request',
    );
  }
  const crossPortCookieNames = new Set(crossPortResponses.flatMap((entry) => entry.cookieNames));
  await secondPreview.close();
  await preview.waitForTimeout(100);
  // Separate anonymous browser context, actual browser fetch metadata, all app/helper/dev assets denied.
  const anonymousContext = await browser.newContext();
  const denied = await anonymousContext.newPage();
  await denied.goto(`${config.previewOrigin}/__gestalt_live/auth`);
  const paths = [
    ...new Set([
      '/',
      '/@vite/client',
      '/src/main.tsx',
      '/src/App.tsx',
      '/src/styles.css',
      '/__gestalt_live/live.js',
      '/__gestalt_live/detect.js',
      '/__gestalt_live/modern-screenshot.js',
      '/__gestalt_live/events',
      '/__gestalt_live/status',
      '/__gestalt_live/health',
      ...[...destinations]
        .filter((destination) => new URL(destination).host === new URL(config.previewOrigin).host)
        .map((destination) => new URL(destination).pathname)
        .filter(
          (path) =>
            !['/__gestalt_live/auth', '/__gestalt_live/exchange', '/__gestalt_live/lease'].includes(
              path,
            ),
        ),
    ]),
  ].sort();
  const denials = await denied.evaluate(async (paths) => {
    const result = [];
    for (const path of paths) {
      const response = await fetch(path);
      result.push({ path, status: response.status });
    }
    const websocketDenied = await new Promise((resolve) => {
      const socket = new WebSocket(`${location.origin.replace('https:', 'wss:')}/`, 'vite-hmr');
      socket.onopen = () => {
        socket.close();
        resolve(false);
      };
      socket.onerror = () => resolve(true);
      setTimeout(() => resolve(false), 3000);
    });
    return { result, websocketDenied };
  }, paths);
  for (const result of denials.result) assert.equal(result.status, 401, result.path);
  assert.equal(denials.websocketDenied, true);
  anonymous.push(...denials.result, { path: '/ (HMR upgrade)', denied: true });
  await anonymousContext.close();
  const sseErrorsBeforeRevocation = await preview.evaluate(() => window.__liveProofSseErrors);
  const revokeStarted = Date.now();
  await command('revoke');
  await preview.waitForFunction(
    (before) => window.__liveProofSseErrors > before,
    sseErrorsBeforeRevocation,
    { timeout: 3000 },
  );
  await preview.waitForTimeout(300);
  assert.equal(hmrClosed, true);
  const revocationElapsedMs = Date.now() - revokeStarted;
  assert.ok(revocationElapsedMs < 3000);
  const revokeNavigation = await preview.goto(`${config.previewOrigin}/`);
  assert.equal(revokeNavigation.status(), 401);
  await preview.getByRole('heading', { name: 'Preview unavailable' }).waitFor();
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    await preview.setViewportSize(viewport);
    assert.equal(
      await preview.evaluate(() => getComputedStyle(document.documentElement).fontSize),
      '16px',
    );
    await preview.screenshot({
      path: `${config.evidence}/remote-preview-denied-${viewport.width}x${viewport.height}.png`,
    });
  }
  const allowed = new Set([
    new URL(config.mobileOrigin).host,
    new URL(config.previewOrigin).host,
    new URL(config.secondPreviewOrigin).host,
  ]);
  for (const destination of destinations)
    assert.ok(
      allowed.has(new URL(destination).host),
      `Unexpected browser destination ${destination}`,
    );
  const sanitized = [...destinations].sort();
  assert.deepEqual(errors, []);
  await writeFile(
    `${config.evidence}/network-destinations.json`,
    JSON.stringify(sanitized, null, 2),
  );
  const result = {
    trustedTls: true,
    ignoreHttpsErrors: false,
    separateBrowserNetwork: true,
    serverNetwork: config.serverNetwork,
    browserNetwork: config.browserNetwork,
    helperLoopbackDenied,
    privateTargetProbes,
    realSimpleWebAuthnEnrollment: true,
    launchPkceViaValidatedOpener: true,
    clearedGrantFragment: true,
    hostOnlyCookiesOnDistinctHosts: true,
    twoLiveAppPortsAmbientCookieIsolation: {
      ...crossPortBlocked,
      responses: crossPortResponses,
      cookieNames: [...crossPortCookieNames],
    },
    realPublishedHelperOverlay: true,
    helperSseConnectedAndErrorReply: true,
    helperSseClosedAfterRevocation: true,
    revocationElapsedMs,
    actualViteHmr: { opened: hmrOpened, updates: hmrUpdates, closedAfterRevocation: hmrClosed },
    anonymous,
    revokeNavigationStatus: revokeNavigation.status(),
    screenshots: [
      'remote-preview-authenticated-390x844.png',
      'remote-preview-authenticated-1440x900.png',
      'remote-preview-denied-390x844.png',
      'remote-preview-denied-1440x900.png',
    ],
    fontSize: '100% / computed 16px',
    destinations: sanitized,
    pageErrors: errors,
  };
  process.stdout.write(`${JSON.stringify({ result })}\n`);
} finally {
  await browser.close();
  commands.close();
}
