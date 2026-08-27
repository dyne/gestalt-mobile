/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type WebSocketRoute } from '@playwright/test';

import { composeRelayApp } from '../../src/server/composition.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from '../../src/server/features/auth/domain/identifiers.js';
import { deviceNickname } from '../../src/server/features/auth/domain/device-nickname.js';
import { SqliteAuthorizationStore } from '../../src/server/platform/auth/sqlite-authorization-store.js';
import type {
  AppServer,
  AppServerLaunchInput,
} from '../../src/server/platform/codex/session-runtime.js';

const fixturePlan = `#+TITLE: Supervised browser lifecycle
#+SUBTITLE: Helper to relay to phone
#+DATE: 2026-08-01
#+KEYWORDS: supervised plan mobile

* TODO [#A] Deliver the supervised lifecycle
:PROPERTIES:
:ID: deliver-lifecycle
:SKILLS: $gestalt:org-plan
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Medium
- Goal :: Prove the reviewed producer and consumer together.
- Notes :: Keep the retained state available through reconnect.

** TODO [#A] Publish the first status
:PROPERTIES:
:ID: publish-first-status
:END:
- Why :: The browser must see the producer output.
- Change :: Publish a deterministic status through the reviewed helper.
- Tests :: Observe the real public endpoint and WebSocket.
- Done when :: The first step is visible and current.

** TODO [#A] Finish after reconnect
:PROPERTIES:
:ID: finish-after-reconnect
:END:
- Why :: Retained progress must survive relay restart.
- Change :: Resume the lifecycle and finish the plan after reconnect.
- Tests :: Observe replacement, review, completion, close, and reload.
- Done when :: The completed plan can be permanently dismissed.
`;

type RelayApp = Awaited<ReturnType<typeof composeRelayApp>>;
type StartedSession = { id: string };

async function updateFixturePlan(
  statusDirectory: string,
  planPath: string,
  command: string,
  id?: string,
  value?: string,
): Promise<void> {
  if ((command === 'set' || command === 'l2') && id && value) {
    const level = command === 'set' ? 1 : 2;
    const source = await readFile(planPath, 'utf8');
    const heading = new RegExp(
      `^(\\*{${level}}) (?:TODO|WIP|DONE)( \\[#.\\][^\\n]*\\n:PROPERTIES:\\n:ID: ${id}\\n)`,
      'm',
    );
    await writeFile(planPath, source.replace(heading, `$1 ${value}$2`));
  }
  if (command === 'review' && id && value) {
    const source = await readFile(planPath, 'utf8');
    await writeFile(
      planPath,
      source.replace(
        new RegExp(`(:ID: ${id}\\n:SKILLS: [^\\n]+\\n:REVIEW_STATUS: )(?:UNREVIEWED|REVIEWED)`),
        `$1${value}`,
      ),
    );
  }
  const canonicalPlanPath = await realpath(planPath);
  const statusFile = join(
    statusDirectory,
    `${createHash('sha256').update(canonicalPlanPath).digest('hex')}.plan-status.json`,
  );
  await writeFile(
    statusFile,
    JSON.stringify({
      schemaVersion: 1,
      planPath: canonicalPlanPath,
      reason: command === 'signal' ? id : command,
      updatedAt: new Date().toISOString(),
    }),
  );
}

function fakeAppServer(input: AppServerLaunchInput, launches: AppServerLaunchInput[]): AppServer {
  launches.push(input);
  const threadId = `thread-${launches.length}`;
  return {
    rpc: {
      request: async (method: string, params: unknown) => {
        if (method === 'model/list') return { data: [{ id: 'gpt-5.6-terra' }] };
        if (method === 'skills/list') {
          const cwd = (params as { cwds: string[] }).cwds[0];
          return { data: [{ cwd, skills: [], errors: [] }] };
        }
        if (method === 'thread/start') return { thread: { id: threadId } };
        if (method === 'thread/read') return { thread: { turns: [] } };
        return {};
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
    },
    close: () => {},
    onExit: () => () => {},
  };
}

async function seedAuthenticatedRelay(
  homeDirectory: string,
  relyingParty: {
    publicOrigin: string;
    rpId: string;
    rpName: 'Gestalt Mobile';
  },
): Promise<void> {
  const store = new SqliteAuthorizationStore(homeDirectory, relyingParty);
  const device = {
    id: authorizedDeviceId('plan-lifecycle-device'),
    credentialId: webAuthnCredentialId('plan-lifecycle-credential'),
    publicKey: new Uint8Array([1]),
    counter: 0,
    transports: ['internal'] as const,
    deviceType: 'singleDevice' as const,
    backedUp: false,
    nickname: deviceNickname('Plan lifecycle device'),
    createdAt: '2026-08-02T00:00:00.000Z',
  };
  store.initializeOwner(new Uint8Array(32).fill(1));
  store.claimFirstDevice(
    { id: localOwnerId('local-owner'), userHandle: new Uint8Array(32).fill(1) },
    device,
  );
  store.saveSession(authorizationSessionId('plan-lifecycle-session'), {
    deviceId: device.id,
    expiresAt: '2026-09-01T00:00:00.000Z',
  });
  store.close();
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test('runs the reviewed helper through the real relay and selected mobile session lifecycle', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-root-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-state-'));
  const homeDirectory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-plan-auth-'));
  const workspace = join(root, 'workspace');
  const planPath = join(workspace, 'lifecycle.org');
  const launches: AppServerLaunchInput[] = [];
  const errors: string[] = [];
  const relayEvents: Array<{ sequence: number; type: string; payload: unknown }> = [];
  const socketUrls: string[] = [];
  const connectedSockets: Array<{ client: WebSocketRoute; server: WebSocketRoute }> = [];
  let app: RelayApp | undefined;
  const relayPort = await reserveLoopbackPort();
  let owningStatusDirectory = '';

  const profiles = {
    list: async () => [{ name: 'default', state: 'ok' as const, status: 'ready' as const }],
    require: async () => ({ name: 'default', state: 'ok' as const, status: 'ready' as const }),
  };
  const relyingParty = {
    publicOrigin: `http://localhost:${relayPort}`,
    rpId: 'localhost',
    rpName: 'Gestalt Mobile' as const,
  };
  const sessionCookie = 'gestalt_mobile_session=plan-lifecycle-session';
  const authorizedFetch = (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    return fetch(url, {
      ...init,
      headers: {
        cookie: sessionCookie,
        ...(method === 'GET' ? {} : { origin: relyingParty.publicOrigin }),
        ...init.headers,
      },
    });
  };
  const startRelay = async (port = relayPort) => {
    app = await composeRelayApp({
      root,
      dataDir,
      homeDirectory,
      relyingParty,
      staticDir: resolve('dist/client'),
      profiles,
      installedCodexVersion: 'codex-cli 0.144.3',
      startAppServers: true,
      launchAppServer: (input) => fakeAppServer(input, launches),
    });
    await app.listen({ host: '127.0.0.1', port });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    return relyingParty.publicOrigin;
  };
  const invokeHelper = async (...args: string[]) => {
    expect(
      owningStatusDirectory,
      'the relay injects a session-owned helper status path',
    ).toBeTruthy();
    const [command, id, value] = args;
    await updateFixturePlan(owningStatusDirectory!, planPath, command!, id, value);
  };

  try {
    await mkdir(workspace);
    await writeFile(planPath, fixturePlan);
    await seedAuthenticatedRelay(homeDirectory, relyingParty);
    const relayUrl = await startRelay();
    await page
      .context()
      .addCookies([
        { name: 'gestalt_mobile_session', value: 'plan-lifecycle-session', url: relayUrl },
      ]);
    const bootstrap = (await authorizedFetch(`${relayUrl}/api/bootstrap`).then((response) =>
      response.json(),
    )) as {
      workspaces: Array<{ children: Array<{ id: string; name: string }> }>;
    };
    const workspaceId = bootstrap.workspaces[0]?.children.find(
      (item) => item.name === 'workspace',
    )?.id;
    expect(workspaceId).toBeTruthy();
    const createSession = async (): Promise<StartedSession> => {
      const response = await authorizedFetch(`${relayUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, profile: 'default', model: 'gpt-5.6-terra' }),
      });
      expect(response.status).toBe(202);
      return response.json() as Promise<StartedSession>;
    };
    const isolatedSession = await createSession();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const owningSession = await createSession();
    const sessionLaunches = launches.filter((launch) => launch.environment);
    expect(sessionLaunches).toHaveLength(2);
    owningStatusDirectory =
      sessionLaunches[1]!.environment!.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY!;
    expect(sessionLaunches[0]!.environment!.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY).not.toBe(
      sessionLaunches[1]!.environment!.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY,
    );

    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    await page.routeWebSocket('**/api/sessions/**/events?after=*', (client) => {
      socketUrls.push(client.url());
      const server = client.connectToServer();
      connectedSockets.push({ client, server });
      server.onMessage((message) => {
        try {
          const envelope = JSON.parse(String(message)) as {
            type?: string;
            event?: { sequence: number; type: string; payload: unknown };
          };
          if (envelope.type === 'relay.event' && envelope.event) relayEvents.push(envelope.event);
        } catch {
          // Only relay JSON frames are relevant to this lifecycle assertion.
        }
        client.send(message);
      });
      client.onMessage((message) => server.send(message));
    });
    const planRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/plan')) planRequests.push(request.url());
    });
    const relayPage = await page.goto(relayUrl);
    expect(relayPage?.status()).toBe(200);
    const navigation = page.getByLabel('Primary');
    const planTab = navigation.getByRole('button', { name: 'Plan' });
    await expect(navigation.getByRole('button')).toHaveText(['Sessions', 'Git', 'Chat', 'Plan']);
    await expect
      .poll(() =>
        socketUrls.some((url) => url.includes(`/api/sessions/${owningSession.id}/events?after=`)),
      )
      .toBe(true);

    await invokeHelper('signal', 'supervision-start');
    await expect
      .poll(async () =>
        authorizedFetch(`${relayUrl}/api/sessions/${owningSession.id}/plan`)
          .then(async (response) => {
            const body = await response.text();
            return body ? (JSON.parse(body) as { title?: string }) : null;
          })
          .then((plan) => plan?.title),
      )
      .toBe('Supervised browser lifecycle');
    await expect
      .poll(async () =>
        authorizedFetch(`${relayUrl}/api/sessions/${owningSession.id}`).then(async (response) => {
          const body = (await response.json()) as {
            autopilot?: { state?: string; enabled?: boolean };
          };
          return body.autopilot?.state;
        }),
      )
      .toMatch(/^(monitoring|backoff)$/);
    await expect
      .poll(async () =>
        authorizedFetch(`${relayUrl}/api/sessions/${owningSession.id}`).then(async (response) => {
          const body = (await response.json()) as { autopilot?: { enabled?: boolean } };
          return body.autopilot?.enabled;
        }),
      )
      .toBe(true);

    const disable = await authorizedFetch(
      `${relayUrl}/api/sessions/${owningSession.id}/autopilot`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(disable.status).toBe(200);
    await invokeHelper('signal', 'supervision-start');
    await expect
      .poll(async () =>
        authorizedFetch(`${relayUrl}/api/sessions/${owningSession.id}`).then(async (response) => {
          const body = (await response.json()) as {
            autopilot?: { state?: string; enabled?: boolean };
          };
          return body.autopilot;
        }),
      )
      .toMatchObject({ state: 'disabled', enabled: false });
    await expect(navigation.getByRole('button', { name: 'Sessions' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await planTab.click();
    await expect(page.getByRole('heading', { name: 'Supervised browser lifecycle' })).toBeVisible();
    await expect(planTab).toBeVisible();
    await expect(planTab).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('details[data-step-id="deliver-lifecycle"]')).toHaveAttribute(
      'open',
      '',
    );

    await invokeHelper('set', 'deliver-lifecycle', 'WIP');
    await invokeHelper('l2', 'publish-first-status', 'WIP');
    await expect(page.getByText('Current: L1.1 Publish the first status (WIP)')).toBeVisible();
    await expect(page.locator('details[data-step-id="publish-first-status"]')).toHaveAttribute(
      'open',
      '',
    );
    await page.locator('details[data-step-id="publish-first-status"] summary').click();
    await expect(page.locator('details[data-step-id="publish-first-status"]')).not.toHaveAttribute(
      'open',
      '',
    );

    await invokeHelper('l2', 'publish-first-status', 'DONE');
    await invokeHelper('l2', 'finish-after-reconnect', 'WIP');
    await expect(page.getByText('Current: L1.2 Finish after reconnect (WIP)')).toBeVisible();
    await expect(page.locator('details[data-step-id="finish-after-reconnect"]')).toHaveAttribute(
      'open',
      '',
    );
    await expect(page.locator('details[data-step-id="publish-first-status"]')).not.toHaveAttribute(
      'open',
      '',
    );

    const requestsBeforeStableWait = planRequests.length;
    await page.waitForTimeout(350);
    expect(planRequests).toHaveLength(requestsBeforeStableWait);

    const cursorBeforeOffline = Math.max(0, ...relayEvents.map((event) => event.sequence));
    const retained = await authorizedFetch(`${relayUrl}/api/sessions/${owningSession.id}/plan`);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({
      doneSteps: 1,
      allDone: false,
      currentStepId: 'finish-after-reconnect',
    });

    await invokeHelper('l2', 'finish-after-reconnect', 'DONE');
    await expect
      .poll(async () =>
        authorizedFetch(`${relayUrl}/api/sessions/${owningSession.id}/plan`)
          .then((response) => response.json())
          .then((plan: { doneSteps: number }) => plan.doneSteps),
      )
      .toBe(2);
    await expect
      .poll(() =>
        relayEvents.find(
          (event) =>
            event.sequence > cursorBeforeOffline &&
            event.type === 'plan.updated' &&
            (event.payload as { plan?: { currentStepId?: string } }).plan?.currentStepId ===
              'deliver-lifecycle' &&
            (event.payload as { plan?: { doneSteps?: number } }).plan?.doneSteps === 2,
        ),
      )
      .toBeTruthy();
    await expect(
      page.getByText('Current: L1 Deliver the supervised lifecycle (WIP)'),
    ).toBeVisible();
    await expect(planTab).toHaveAttribute('aria-pressed', 'true');

    await invokeHelper('set', 'deliver-lifecycle', 'DONE');
    await expect(page.getByText('1 / 3 complete')).not.toBeVisible();
    await expect(page.getByText('3 / 3 complete')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close plan and return to list' })).toBeVisible();
    await expect(page.getByText('DONE · Priority A · UNREVIEWED').first()).toBeVisible();
    await invokeHelper('review', 'deliver-lifecycle', 'REVIEWED');
    await expect(page.getByText('DONE · Priority A · REVIEWED')).toBeVisible();

    await navigation.getByRole('button', { name: 'Sessions' }).click();
    await page.evaluate(() => {
      (
        window as typeof window & { __planSeenDuringIsolation?: boolean }
      ).__planSeenDuringIsolation = false;
      new MutationObserver(() => {
        const plan = [...document.querySelectorAll('nav button')].some(
          (button) => button.textContent === 'Plan',
        );
        if (plan)
          (
            window as typeof window & { __planSeenDuringIsolation?: boolean }
          ).__planSeenDuringIsolation = true;
      }).observe(document.querySelector('nav')!, { childList: true, subtree: true });
    });
    const sessionItems = page.getByLabel('Open sessions').locator(':scope > li');
    await expect(sessionItems).toHaveCount(2);
    const listedSessions = (await authorizedFetch(`${relayUrl}/api/bootstrap`).then((response) =>
      response.json(),
    )) as {
      sessions: Array<{ id: string }>;
    };
    const isolatedIndex = listedSessions.sessions.findIndex(
      (session) => session.id === isolatedSession.id,
    );
    const owningIndex = listedSessions.sessions.findIndex(
      (session) => session.id === owningSession.id,
    );
    expect(isolatedIndex).toBeGreaterThanOrEqual(0);
    expect(owningIndex).toBeGreaterThanOrEqual(0);
    await sessionItems.nth(isolatedIndex).getByRole('button', { name: 'Open' }).click();
    await expect(planTab).toHaveCount(1);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __planSeenDuringIsolation?: boolean })
            .__planSeenDuringIsolation,
      ),
    ).toBe(false);
    const isolatedPlan = await authorizedFetch(
      `${relayUrl}/api/sessions/${isolatedSession.id}/plan`,
    );
    expect(isolatedPlan.status).toBe(204);

    await navigation.getByRole('button', { name: 'Sessions' }).click();
    await sessionItems.nth(owningIndex).getByRole('button', { name: 'Open' }).click();
    await expect(planTab).toBeVisible();
    await planTab.click();
    await page.getByRole('button', { name: 'Close plan and return to list' }).click();
    await expect(planTab).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();
    await expect(planTab).toHaveAttribute('aria-pressed', 'true');
    expect(
      await authorizedFetch(`${relayUrl}/api/sessions/${owningSession.id}/plan`).then(
        (response) => response.status,
      ),
    ).toBe(200);
    await page.reload();
    await expect(navigation.getByRole('button')).toHaveText(['Sessions', 'Git', 'Chat', 'Plan']);
    await expect(planTab).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await page.close().catch(() => {});
    await app?.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
      rm(homeDirectory, { recursive: true, force: true }),
    ]);
  }
});
