/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { composeRelayApp } from '../../composition.js';
import { workspaceId } from '../catalog/workspace-id.js';
import { liveAppIdentity, SqliteLiveOwnership } from './sqlite-live-ownership.js';

describe('production composition native admission', () => {
  it.each([false, true])(
    'ordinary discovery/start succeeds with a controller; earlier catalog=%s',
    async (earlierCatalog) => {
      const root = mkdtempSync(join(tmpdir(), 'live-composition-ordinary-'));
      const projects = join(root, 'projects');
      const workspace = join(projects, 'app');
      const other = join(projects, 'other');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(other);
      const owners = new SqliteLiveOwnership(join(root, 'private', 'live.sqlite'), 'controller', {
        initialize: true,
      });
      const calls: string[] = [];
      let releaseModels: (() => void) | undefined;
      let slowModels = false;
      const launch = vi.fn(() => ({
        rpc: {
          request: async (method: string, params: unknown) => {
            calls.push(method);
            if (method === 'model/list') {
              if (slowModels)
                await new Promise<void>((resolve) => {
                  releaseModels = resolve;
                });
              return { data: [{ id: 'gpt-5.6-terra' }] };
            }
            if (method === 'skills/list')
              return {
                data: [{ cwd: (params as { cwds: string[] }).cwds[0], skills: [], errors: [] }],
              };
            if (method === 'thread/start')
              return { thread: { id: `root-${launch.mock.calls.length}` } };
            if (method === 'turn/start') return { turn: { id: 'ordinary-turn' } };
            return {};
          },
          onNotification: () => () => {},
          onServerRequest: () => () => {},
        },
        close: vi.fn(),
        onExit: () => () => {},
      }));
      const app = await composeRelayApp({
        root: projects,
        dataDir: join(root, 'relay'),
        homeDirectory: join(root, 'home'),
        relyingParty: {
          publicOrigin: 'http://localhost:3000',
          rpId: 'localhost',
          rpName: 'Gestalt Mobile',
        },
        passkeyAuthEnabled: false,
        profiles: {
          list: async () => [],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
        installedCodexVersion: 'codex-cli 0.144.3',
        startAppServers: true,
        launchAppServer: launch,
        xerj: 'off',
        liveController: { owners, scopes: (session) => [session.workspacePath] },
      });
      const create = (path: string) =>
        app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: {
            workspaceId: workspaceId(path),
            profile: 'default',
            provider: 'codex',
            model: 'gpt-5.6-terra',
          },
        });
      const claim = (path = workspace) =>
        owners.claim({
          relayId: 'live-other',
          rootThreadId: 'live-root',
          provider: 'codex',
          appId: 'app',
          app: liveAppIdentity(path),
          targetId: 'registered',
          targetIdentity: 'listener',
          operationId: 'live-start',
          previewOrigin: 'https://preview.example.test:9443',
          authSessionHash: 'auth',
          deviceId: 'device',
        });
      try {
        if (earlierCatalog) {
          const discovered = await app.inject({ method: 'POST', url: '/api/session-models/codex' });
          expect(discovered.statusCode).toBe(200);
          expect(discovered.json().models).toContain('gpt-5.6-terra');
          expect(() => claim(other)).toThrow('LIVE_SESSION_BUSY');
        }
        slowModels = true;
        const creating = create(workspace);
        await vi.waitFor(() => expect(releaseModels).toBeDefined());
        expect(() => claim()).toThrow('LIVE_SESSION_BUSY');
        expect(() => claim(other)).toThrow('LIVE_SESSION_BUSY');
        slowModels = false;
        releaseModels!();
        const first = await creating;
        expect(first.statusCode).toBe(202);
        const session = first.json();
        expect(session.provider).toBe('codex');
        expect(calls).toContain('model/list');
        expect(calls).toContain('skills/list');
        expect(calls).toContain('thread/start');
        const callsBefore = calls.length;
        const overlap = await create(workspace);
        expect(overlap.statusCode).toBe(409);
        expect(overlap.json().code).toBe('LIVE_SESSION_BUSY');
        expect(calls).toHaveLength(callsBefore);
        // An independent catalog request after an existing session cannot disable ordinary work.
        expect(
          (await app.inject({ method: 'POST', url: '/api/session-models/codex' })).statusCode,
        ).toBe(200);
        expect((await create(other)).statusCode).toBe(202);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/sessions/${session.id}/model`,
              payload: { model: 'gpt-5.6-terra' },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/sessions/${session.id}/turns`,
              payload: { text: 'ordinary after catalog' },
            })
          ).statusCode,
        ).toBe(202);
        expect(calls).toContain('turn/start');
        expect(() => claim(other)).toThrow('LIVE_SESSION_BUSY');
      } finally {
        await app.close();
        owners.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it.each(['controller', 'reader'] as const)(
    '%s denies new-session discovery, cached catalog spawns and workspace plan archive',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'live-composition-'));
      const workspace = join(root, 'projects', 'app');
      mkdirSync(workspace, { recursive: true });
      const plan = join(workspace, 'plan.org');
      writeFileSync(plan, 'protected plan');
      const owners = new SqliteLiveOwnership(join(root, 'private', 'live.sqlite'), 'controller', {
        initialize: true,
      });
      owners.claim({
        relayId: 'other-relay',
        rootThreadId: 'root',
        provider: 'codex',
        appId: 'app',
        app: liveAppIdentity(workspace),
        targetId: 'registered',
        targetIdentity: 'listener',
        operationId: 'start',
        previewOrigin: 'https://preview.example.test:9443',
        authSessionHash: 'auth',
        deviceId: 'device',
      });
      const launch = vi.fn(() => {
        throw new Error('FORBIDDEN_PROCESS_CALL');
      });
      const ensure = vi.fn(async () => {
        throw new Error('FORBIDDEN_KIMI_CALL');
      });
      const app = await composeRelayApp({
        root: join(root, 'projects'),
        dataDir: join(root, 'relay'),
        homeDirectory: join(root, 'home'),
        relyingParty: {
          publicOrigin: 'http://localhost:3000',
          rpId: 'localhost',
          rpName: 'Gestalt Mobile',
        },
        passkeyAuthEnabled: false,
        profiles: {
          list: async () => [],
          require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
        },
        installedCodexVersion: 'codex-cli 0.144.3',
        installedKimiVersion: 'kimi 1.0.0',
        startAppServers: true,
        launchAppServer: launch,
        kimiServerManager: {
          ensure,
          list: () => [],
          stopAll: async () => {},
        } as never,
        xerj: 'off',
        ...(mode === 'controller'
          ? { liveController: { owners, scopes: (session) => [session.workspacePath] } }
          : { liveOwnership: owners }),
      });
      try {
        // Read-side discovery degrades to an empty catalog without starting a process.
        expect((await app.inject('/api/bootstrap')).statusCode).toBe(200);
        for (const provider of ['codex', 'kimi']) {
          const response = await app.inject({
            method: 'POST',
            url: '/api/sessions',
            payload: { workspaceId: workspaceId(workspace), profile: 'default', provider },
          });
          expect(response.statusCode).toBe(mode === 'controller' ? 409 : 503);
          expect(response.json().code).toBe(
            mode === 'controller' ? 'LIVE_MODE_ACTIVE' : 'LIVE_STATE_UNAVAILABLE',
          );
        }
        const archive = await app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspaceId(workspace)}/plans/plan.org/archive`,
        });
        expect(archive.statusCode).toBe(mode === 'controller' ? 409 : 503);
        expect(readFileSync(plan, 'utf8')).toBe('protected plan');
        expect((await app.inject('/api/sessions')).json()).toEqual([]);
        expect(launch).not.toHaveBeenCalled();
        expect(ensure).not.toHaveBeenCalled();
      } finally {
        await app.close();
        owners.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
