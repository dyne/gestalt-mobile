/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { composeRelayApp } from '../../src/server/composition.js';
import {
  authorizationSessionId,
  authorizedDeviceId,
  localOwnerId,
  webAuthnCredentialId,
} from '../../src/server/features/auth/domain/identifiers.js';
import { deviceNickname } from '../../src/server/features/auth/domain/device-nickname.js';
import { SqliteAuthorizationStore } from '../../src/server/platform/auth/sqlite-authorization-store.js';
import type { AppServer } from '../../src/server/platform/codex/session-runtime.js';
import { planStatusFilePath } from '../../src/server/platform/plans/filesystem-plan-status-source.js';

const legacyPlan = `#+TITLE: Synthetic policy relay boundary
* WIP [#A] Validate the boundary
:PROPERTIES:
:ID: boundary
:SKILLS: $nodejs-backend-patterns
:REVIEW_STATUS: UNREVIEWED
:END:
- Effort :: Medium
- Goal :: Observe configured settings without admitting unsupported work.
- Notes :: Synthetic fixture, no production data.
** TODO [#A] Verify relay behavior
:PROPERTIES:
:ID: relay
:END:
- Why :: Exercise the production composition.
- Change :: Publish synthetic state.
- Tests :: HTTP and host-owned health evidence.
- Done when :: Unsupported automation stays off.
`;
const versionedPlan =
  '#+MODEL_POLICY_VERSION: 1\n' +
  legacyPlan.replace(
    ':REVIEW_STATUS: UNREVIEWED',
    `:REVIEW_STATUS: UNREVIEWED
:MODEL: gpt-6-luna
:REASONING_EFFORT: medium
:MODEL_RATIONALE: Mechanical synthetic fixture with deterministic acceptance.
:MODEL_FALLBACKS: none
:MODEL_ESCALATION_TRIGGER: A focused correctness check fails.`,
  );

type Handle = {
  root: string;
  statusDirectory?: string;
  capabilities?: string;
  requests: Array<{ method: string; params: unknown }>;
  tool?: Parameters<AppServer['rpc']['onServerRequest']>[0];
};

for (const assurance of ['configured', 'runtime-attested'] as const) {
  test(`publication, ${assurance} admission and child diagnostics agree through the real relay`, async () => {
    await verifyRelayPolicy(assurance);
  });
}

async function verifyRelayPolicy(assurance: 'configured' | 'runtime-attested') {
  test.setTimeout(45_000);
  const directory = await mkdtemp(join(tmpdir(), 'gestalt-model-policy-relay-'));
  const root = join(directory, 'root');
  const workspace = join(root, 'workspace');
  const dataDir = join(directory, 'state');
  const homeDirectory = join(directory, 'auth');
  const planPath = join(workspace, 'policy.org');
  await mkdir(workspace, { recursive: true });
  await mkdir(homeDirectory);
  const relyingParty = {
    publicOrigin: 'http://localhost:3000',
    rpId: 'localhost',
    rpName: 'Gestalt Mobile' as const,
  };
  const authorization = new SqliteAuthorizationStore(homeDirectory, relyingParty);
  const userHandle = new Uint8Array(32).fill(1);
  authorization.initializeOwner(userHandle);
  authorization.claimFirstDevice(
    { id: localOwnerId('local-owner'), userHandle },
    {
      id: authorizedDeviceId('policy-device'),
      credentialId: webAuthnCredentialId('policy-credential'),
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      nickname: deviceNickname('Policy fixture'),
      createdAt: '2026-10-21T00:00:00.000Z',
    },
  );
  authorization.saveSession(authorizationSessionId('policy-session'), {
    deviceId: authorizedDeviceId('policy-device'),
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  authorization.close();

  const handles: Handle[] = [];
  const timers: Array<{ callback: () => void; cancelled: boolean }> = [];
  let owningRoot = '';
  let configuredModel = 'gpt-6-luna';
  let configuredEffort: string | undefined = 'medium';
  let catalogAvailable = true;
  const app = await composeRelayApp({
    root,
    dataDir,
    homeDirectory,
    relyingParty,
    installedCodexVersion: 'codex-cli 0.144.3',
    startAppServers: true,
    profiles: {
      list: async () => [],
      require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
    },
    autopilotSchedule: (callback) => {
      const timer = { callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    launchAppServer: (input) => {
      const handle: Handle = {
        root: `root-${handles.length}`,
        statusDirectory: input.environment?.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY,
        capabilities: input.environment?.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES,
        requests: [],
      };
      handles.push(handle);
      if (handle.statusDirectory) owningRoot = handle.root;
      const child = {
        id: `child-${owningRoot}`,
        parentThreadId: owningRoot,
        source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } },
        status: { type: 'idle' },
      };
      return {
        rpc: {
          request: async (method, params) => {
            handle.requests.push({ method, params });
            if (method === 'skills/list')
              return { data: [{ cwd: input.cwd, skills: [], errors: [] }] };
            if (method === 'thread/start') return { thread: { id: handle.root } };
            if (method === 'thread/resume')
              return { thread: { id: (params as { threadId: string }).threadId } };
            if (method === 'model/list') {
              if (!catalogAvailable) throw new Error('SYNTHETIC_CATALOG_UNAVAILABLE');
              return {
                data: ['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'].map((id) => ({
                  id,
                  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
                })),
              };
            }
            if (method === 'thread/list') return { data: [child] };
            if (method === 'thread/read') {
              const threadId = (params as { threadId: string }).threadId;
              return {
                thread:
                  threadId === child.id
                    ? {
                        ...child,
                        model: configuredModel,
                        reasoningEffort: configuredEffort,
                        agentRole: 'org-plan-executor',
                        turns: [],
                      }
                    : {
                        id: threadId,
                        status: { type: 'idle' },
                        model: 'gpt-6-astra',
                        turns: [],
                      },
              };
            }
            if (method === 'turn/start') return { turn: { id: 'manual-turn' } };
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: (listener) => {
            handle.tool = listener;
            return () => {};
          },
        },
        close: () => {},
        onExit: () => () => {},
      };
    },
  });
  let database: DatabaseSync | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    const url = `http://127.0.0.1:${address.port}`;
    const request = (path: string, method = 'GET', body?: unknown) =>
      fetch(url + path, {
        method,
        headers: {
          cookie: 'gestalt_mobile_session=policy-session',
          origin: relyingParty.publicOrigin,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const bootstrap = await (await request('/api/bootstrap')).json();
    const workspaceId = bootstrap.workspaces[0].children.find(
      (item: { name: string }) => item.name === 'workspace',
    ).id;
    const createSession = async () => {
      const result = await request('/api/sessions', 'POST', {
        workspaceId,
        profile: 'default',
        provider: 'codex',
        model: 'gpt-6-astra',
      });
      expect(result.status).toBe(202);
      const { id } = await result.json();
      await expect
        .poll(async () => (await (await request(`/api/sessions/${id}`)).json()).state)
        .toBe('ready');
      return id as string;
    };
    const sessionId = await createSession();
    const handle = handles.find((candidate) => candidate.statusDirectory)!;
    const base = `/api/sessions/${sessionId}`;
    database = new DatabaseSync(join(dataDir, 'relay.sqlite'), { readOnly: true });
    const executor = () => {
      const row = database!
        .prepare('SELECT lifecycle_json FROM autopilot_sessions WHERE session_id = ?')
        .get(sessionId) as { lifecycle_json: string } | undefined;
      return row ? JSON.parse(row.lifecycle_json).executor : undefined;
    };
    // Synthetic producer publications exercise the same session-owned wire format;
    // actual Agents helper publication/negotiation is covered by model-policy.test.ts.
    const publish = async (versioned: boolean, reason = 'resync', version = 1) => {
      await writeFile(
        planPath,
        versioned ? `#+MODEL_POLICY_ASSURANCE: ${assurance}\n${versionedPlan}` : legacyPlan,
      );
      await writeFile(
        planStatusFilePath(handle.statusDirectory!, planPath),
        JSON.stringify({
          schemaVersion: 1,
          planPath,
          reason,
          updatedAt: new Date().toISOString(),
          ...(versioned
            ? { modelPolicyVersion: version, requiredCapabilities: ['l1-model-policy-v1'] }
            : {}),
        }),
      );
      // Explicit plan retrieval refreshes the authoritative publication without
      // waiting for filesystem debounce or running a model-probe turn.
      const refreshed = await request(`${base}/plan`);
      expect(refreshed.status, await refreshed.text()).toBe(version === 1 ? 200 : 204);
    };
    const session = async () => (await request(base)).json();
    let toolId = 1000;
    const health = async () => {
      const result = (await handle.tool!({
        id: toolId++,
        method: 'item/tool/call',
        params: { tool: 'gestalt_org_plan_health', arguments: {} },
      })) as {
        success: boolean;
        contentItems: Array<{ text: string }>;
      };
      expect(result.success).toBe(true);
      return JSON.parse(result.contentItems[0]!.text);
    };
    const work = () =>
      handles
        .flatMap((h) => h.requests)
        .filter((r) => ['turn/start', 'turn/steer'].includes(r.method));

    await publish(false, 'supervision-start');
    await request(`${base}/activity/refresh`, 'POST');
    await expect.poll(() => executor()?.threadId).toBe(`child-${handle.root}`);
    expect((await session()).autopilot.enabled).toBe(true);
    expect(work()).toEqual([]);
    const scheduledLegacy = timers.filter((timer) => !timer.cancelled);
    expect(scheduledLegacy.length).toBeGreaterThan(0);

    await publish(true, 'supervision-start');
    const configured = assurance === 'configured';
    await expect.poll(async () => (await session()).autopilot.enabled).toBe(configured);
    expect((await health()).executionAdmission).toMatchObject(
      configured
        ? { allowed: true, scope: 'configured', assurance, runtimeEnforcement: false }
        : { allowed: false, reason: 'RUNTIME_ATTESTATION_UNAVAILABLE' },
    );
    // Configured admission permits automation without claiming attestation.
    // Manual Off still fences callbacks scheduled under the earlier legacy plan.
    if (configured) {
      expect((await request(`${base}/autopilot`, 'PUT', { enabled: true })).status).toBe(200);
      expect((await request(`${base}/autopilot`, 'PUT', { enabled: false })).status).toBe(200);
      expect((await session()).autopilot.enabled).toBe(false);
    }
    expect((await (await request(`${base}/plan`)).json()).modelPolicyVersion).toBe(1);
    const beforeHealth = handle.requests.length;
    const observedPolicy = (await health()).modelPolicy;
    expect(observedPolicy).toMatchObject({
      requested: { model: 'gpt-6-luna', reasoningEffort: 'medium' },
      effective: { model: 'gpt-6-luna', reasoningEffort: 'medium' },
      child: { threadId: `child-${handle.root}`, generation: 1 },
      evidenceScope: 'configured-thread-settings',
      source: 'runtime-thread-metadata',
      catalogRevisionSource: 'normalized-content-digest',
      configuration: 'match',
      code: 'RUNTIME_REVISION_UNKNOWN',
      settingsRevision: null,
      runtimeEnforcement: false,
      admitted: false,
      assurance,
    });
    expect(observedPolicy.unknown).toContain('settingsRevision');
    expect(Buffer.byteLength(JSON.stringify(observedPolicy))).toBeLessThanOrEqual(2048);
    const healthRequests = handle.requests.slice(beforeHealth);
    expect(healthRequests).toEqual(
      expect.arrayContaining([
        {
          method: 'thread/read',
          params: { threadId: `child-${handle.root}`, includeTurns: false },
        },
        { method: 'model/list', params: {} },
      ]),
    );
    // Health also reconciles controller ownership. Every call remains a scoped
    // metadata read; it must never resume a child or execute a turn.
    for (const call of healthRequests) {
      expect([
        { method: 'thread/read', params: { threadId: handle.root, includeTurns: false } },
        {
          method: 'thread/read',
          params: { threadId: `child-${handle.root}`, includeTurns: false },
        },
        { method: 'thread/list', params: { parentThreadId: handle.root } },
        { method: 'model/list', params: {} },
      ]).toContainEqual(call);
    }
    // Even cancelled callbacks cannot reuse the older legacy authority.
    for (const timer of scheduledLegacy) timer.callback();
    if (!configured) {
      const blocked = await request(`${base}/autopilot`, 'PUT', { enabled: true });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ code: 'AUTOPILOT_MODEL_POLICY_UNAVAILABLE' });
      expect((await health()).executionAdmission).toMatchObject({
        allowed: false,
        reason: 'RUNTIME_ATTESTATION_UNAVAILABLE',
      });
    }
    expect((await session()).autopilot.enabled).toBe(false);
    expect(work()).toEqual([]);

    configuredModel = 'gpt-6-astra';
    expect((await health()).modelPolicy).toMatchObject({
      configuration: 'mismatch',
      code: 'MODEL_MISMATCH',
      admitted: false,
    });
    configuredModel = 'gpt-6-luna';
    configuredEffort = undefined;
    expect((await health()).modelPolicy).toMatchObject({
      configuration: 'unknown',
      code: 'RUNTIME_SETTINGS_UNKNOWN',
      effective: { reasoningEffort: null },
    });
    configuredEffort = 'medium';
    catalogAvailable = false;
    expect((await health()).modelPolicy).toMatchObject({
      configuration: 'unknown',
      code: 'CATALOG_UNKNOWN',
    });
    catalogAvailable = true;
    expect((await health()).modelPolicy).toMatchObject({
      configuration: 'match',
      admitted: false,
      runtimeEnforcement: false,
    });
    expect(work()).toEqual([]);

    // Invalid mixed-version publication cannot restore the retained legacy authority.
    await publish(true, 'resync', 2);
    expect((await request(`${base}/autopilot`, 'PUT', { enabled: true })).status).toBe(409);
    expect((await health()).executionAdmission).toMatchObject({
      allowed: false,
      reason: 'POLICY_PROJECTION_UNAVAILABLE',
    });
    await publish(true);
    expect((await health()).modelPolicy.configuration).toBe('match');
    expect((await session()).autopilot.enabled).toBe(false);

    const isolatedId = await createSession();
    expect(
      (await (await request(`/api/sessions/${isolatedId}`)).json()).autopilot.executionAdmission,
    ).toBeUndefined();
    expect((await request(`${base}/model`, 'POST', { model: 'gpt-6-sol' })).status).toBe(200);
    expect(
      (
        await request(`${base}/turns`, 'POST', {
          text: 'Synthetic manual review',
          clientUserMessageId: 'manual-policy-review',
        })
      ).status,
    ).toBe(202);
    expect(work()).toHaveLength(1);
    expect(work()[0]).toMatchObject({
      method: 'turn/start',
      params: { threadId: handle.root, model: 'gpt-6-sol' },
    });
    const manifest = JSON.parse(await readFile('gestalt-supervision-capabilities.json', 'utf8'));
    expect(manifest.capabilities).toContain('l1-model-policy-v1');
    expect(handle.capabilities?.split(',')).toContain('l1-model-policy-v1');
    expect(manifest.modelPolicyContract).toEqual({
      version: 1,
      scope: 'configured-launch-and-retention',
      defaultAssurance: 'configured',
      runtimeEnforcement: false,
      strictAttestation: false,
    });
    const audit = database
      .prepare(
        "SELECT payload_json FROM session_events WHERE session_id = ? AND type = 'autopilot.model-policy-rejected'",
      )
      .all(sessionId);
    expect(audit.length).toBeGreaterThan(0);
    for (const event of audit) {
      expect(Buffer.byteLength(String(event.payload_json))).toBeLessThanOrEqual(2048);
      expect(String(event.payload_json)).not.toContain('Synthetic manual review');
    }
  } finally {
    database?.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
