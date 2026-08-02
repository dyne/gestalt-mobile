/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { composeRelayApp } from '../src/server/composition.js';
import {
  CodexJsonRpcError,
  isMissingCodexThreadRollout,
} from '../src/server/platform/codex/json-rpc-client.js';
import { launchCodexAppServer } from '../src/server/platform/codex/codex-process-launcher.js';

const profile = 'gestalt';

type Session = { id: string; threadId: string | null; state: string; recovery?: unknown };

async function main(): Promise<void> {
  const installedCodexVersion = isolatedProfileCodexVersion();
  if (!installedCodexVersion) {
    console.log('SKIP: isolated Gestalt profile is unavailable.');
    return;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'gestalt-mobile-open-smoke-'));
  const workspace = join(temporaryRoot, 'workspace');
  const smokeThreadIds = new Set<string>();
  let app: Awaited<ReturnType<typeof composeRelayApp>> | undefined;
  const rpcLifecycle: string[] = [];
  try {
    const dataDir = join(temporaryRoot, 'state');
    await mkdir(workspace);
    app = await composeRelayApp({
      root: workspace,
      dataDir,
      profiles: { list: async () => [{ name: profile, state: 'ok', status: 'ready' }], require: async () => ({ name: profile, state: 'ok', status: 'ready' }) },
      installedCodexVersion,
      startAppServers: true,
      launchAppServer: tracedAppServer(rpcLifecycle),
    });

    const bootstrap = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as {
      workspaces: Array<{ id: string }>;
      models: string[];
    };
    const model = bootstrap.models[0];
    if (!bootstrap.workspaces[0] || !model) throw new Error('isolated profile did not expose a workspace model');
    const normal = await create(app, bootstrap.workspaces[0].id, model);
    if (normal.threadId) smokeThreadIds.add(normal.threadId);
    await persistMinimalHistory(app, normal.id);
    await release(app, normal.id);
    const resumed = await restore(app, normal.id, rpcLifecycle);
    if (resumed.state !== 'ready' || resumed.threadId !== normal.threadId || resumed.recovery)
      throw new Error(
        `normal Open did not resume its original thread (ready=${resumed.state === 'ready'} sameThread=${resumed.threadId === normal.threadId} recovery=${Boolean(resumed.recovery)}); RPC lifecycle: ${rpcLifecycle.join(', ')}`,
      );

    await release(app, normal.id);
    const missingId = randomUUID();
    // Codex validates thread identifiers before looking up a rollout.
    const absentThreadId = randomUUID();
    seedAbsentRollout(join(dataDir, 'relay.sqlite'), normal.id, missingId, absentThreadId);
    const replaced = await restore(app, missingId, rpcLifecycle);
    if (
      replaced.state !== 'ready' ||
      !replaced.threadId ||
      replaced.threadId === absentThreadId ||
      JSON.stringify(replaced.recovery) !== JSON.stringify({ historyUnavailable: true, replacementCreated: true })
    )
      throw new Error('missing rollout Open did not create and bind a replacement thread');
    smokeThreadIds.add(replaced.threadId);
    await release(app, missingId);
    console.log('PASS: normal Open resumed and missing rollout Open created a replacement thread.');
  } finally {
    await app?.close();
    await deleteSmokeThreads(workspace, smokeThreadIds);
    await rm(temporaryRoot, { recursive: true, force: true });
    if (existsSync(temporaryRoot)) throw new Error('temporary smoke state was not cleaned up');
  }
}

function tracedAppServer(lifecycle: string[]) {
  return (input: Parameters<typeof launchCodexAppServer>[0]) => {
    const server = launchCodexAppServer(input);
    return {
      ...server,
      rpc: {
        onNotification: server.rpc.onNotification.bind(server.rpc),
        onServerRequest: server.rpc.onServerRequest.bind(server.rpc),
        request: async (method: string, params: unknown) => {
          lifecycle.push(method);
          try {
            return await server.rpc.request(method, params);
          } catch (error) {
            lifecycle.push(
              error instanceof CodexJsonRpcError && isMissingCodexThreadRollout(error)
                ? `${method}:CODEX_THREAD_NOT_FOUND`
                : `${method}:FAILED`,
            );
            throw error;
          }
        },
      },
    };
  };
}

function isolatedProfileCodexVersion(): string | null {
  if (!existsSync(join(homedir(), '.codex-gestalt'))) return null;
  const result = spawnSync('codex-profile', ['cli', profile, '--version'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) return null;
  const version = result.stdout.trim();
  return /^codex-cli \d+\.\d+\.\d+$/.test(version) ? version : null;
}

async function deleteSmokeThreads(workspace: string, threadIds: ReadonlySet<string>): Promise<void> {
  if (!threadIds.size) return;
  const server = launchCodexAppServer({ profile, cwd: workspace });
  try {
    await server.rpc.request('initialize', {
      clientInfo: { name: 'gestalt-mobile-smoke-cleanup', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    for (const threadId of threadIds) {
      try {
        await server.rpc.request('thread/delete', { threadId });
      } catch (error) {
        // A replacement with no completed turn is ephemeral and already absent.
        if (isMissingCodexThreadRollout(error)) continue;
        throw error;
      }
      try {
        await server.rpc.request('thread/resume', { threadId, cwd: workspace, dynamicTools: [] });
      } catch (error) {
        if (isMissingCodexThreadRollout(error)) continue;
      }
      throw new Error('smoke-created Codex thread cleanup could not be verified');
    }
  } finally {
    server.close();
  }
}

async function create(
  app: Awaited<ReturnType<typeof composeRelayApp>>,
  workspaceId: string,
  model: string,
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { workspaceId, profile, model, sandbox: 'workspace-write', approvalPolicy: 'never' },
  });
  if (response.statusCode !== 202) throw new Error(`session creation failed (${response.statusCode})`);
  return response.json() as Session;
}

async function release(app: Awaited<ReturnType<typeof composeRelayApp>>, id: string): Promise<void> {
  const response = await app.inject({ method: 'POST', url: `/api/sessions/${id}/release` });
  if (response.statusCode !== 202) throw new Error(`session release failed (${response.statusCode})`);
}

/** Creates the smallest durable local history allowed for this isolated smoke only. */
async function persistMinimalHistory(
  app: Awaited<ReturnType<typeof composeRelayApp>>,
  id: string,
): Promise<void> {
  const started = await app.inject({
    method: 'POST',
    url: `/api/sessions/${id}/turns`,
    // This is deliberately harmless and has no workspace action or sensitive content.
    payload: { text: 'Compatibility smoke: acknowledge without performing work.' },
  });
  if (started.statusCode !== 202) throw new Error(`bounded smoke turn failed (${started.statusCode})`);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
    const session = response.json() as Session & { activeTurnId?: string | null };
    if (response.statusCode === 200 && session.activeTurnId === null) return;
  }
  throw new Error('bounded smoke turn did not complete within 60 seconds');
}

async function restore(
  app: Awaited<ReturnType<typeof composeRelayApp>>,
  id: string,
  rpcLifecycle: readonly string[],
): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: `/api/sessions/${id}/restore` });
  if (response.statusCode !== 200) {
    const body = response.json() as { code?: unknown };
    throw new Error(
      `session Open failed (${response.statusCode}, code=${typeof body.code === 'string' ? body.code : 'unknown'}); RPC lifecycle: ${rpcLifecycle.join(', ')}`,
    );
  }
  return response.json() as Session;
}

function seedAbsentRollout(databasePath: string, sourceId: string, targetId: string, absentThreadId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        'INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,model,branch,thread_id,state,desired_state,active_turn_id,protocol_version,failure_count,effective_skill_selection_json,last_org_plan_json,created_at,updated_at) SELECT ?,workspace_id,workspace_path,profile,model,branch,?,state,desired_state,active_turn_id,protocol_version,failure_count,effective_skill_selection_json,last_org_plan_json,created_at,updated_at FROM relay_sessions WHERE id = ?',
      )
      .run(targetId, absentThreadId, sourceId);
    const row = database.prepare('SELECT id FROM relay_sessions WHERE id = ?').get(targetId);
    if (!row) throw new Error('failed to seed missing rollout relay session');
  } finally {
    database.close();
  }
}

await main();
