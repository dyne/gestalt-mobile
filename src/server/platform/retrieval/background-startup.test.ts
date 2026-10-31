/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagedXerj } from './managed-xerj.js';
import { CodexXerj, xerjTools } from './codex-xerj.js';
import { CodexCapabilities } from '../codex/codex-capabilities.js';
import { CodexSerena } from '../codex/codex-serena.js';
import { CodexSessionRuntime, type AppServer } from '../codex/session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { normalizeCodexNotification } from '../codex/normalizer.js';

describe('shared backend startup at runtime boundaries', () => {
  it.each(['delayed', 'authentication-failed'] as const)(
    'starts chat safely with %s preparation and activates only at resume',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'mobile background xerj '));
      const manager = join(root, 'manager');
      const skill = join(root, 'SKILL.md');
      await writeFile(skill, '# XERJ retrieval');
      await writeFile(
        manager,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('calls', process.argv[3] + '\\n');
const reply = () => console.log(JSON.stringify(${
          mode === 'delayed'
            ? JSON.stringify({
                schemaVersion: 1,
                status: 'ready',
                version: '1.0.0-rc.100',
                endpoint: 'http://127.0.0.1:19200',
              })
            : JSON.stringify({
                schemaVersion: 1,
                status: 'unavailable',
                reason: 'authentication-failed',
                stderr: 'secret credential',
              })
        }));
if (${JSON.stringify(mode)} !== 'delayed' || fs.existsSync('release')) reply();
else { const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); reply(); } }, 10); }
`,
        { mode: 0o700 },
      );
      const managed = new ManagedXerj({ PATH: process.env.PATH, GESTALT_MANAGER_BIN: manager });
      const capabilities = new CodexCapabilities(
        new CodexXerj(managed),
        new CodexSerena({ check: async () => ({ status: 'absent' }) }),
      );
      const requests: Array<{ method: string; params: unknown }> = [];
      const notices: Array<{ method: string; params: unknown }> = [];
      const rpc: AppServer['rpc'] = {
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === 'config/read') return { config: {} };
          if (method === 'thread/start' || method === 'thread/resume')
            return { thread: { id: 'same-thread' } };
          if (method === 'mcpServerStatus/list')
            return {
              data: [
                {
                  name: 'gestalt-xerj',
                  runtimeStatus: 'connected',
                  tools: Object.fromEntries(xerjTools.map((tool) => [tool, {}])),
                },
              ],
            };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      };
      const runtime = new CodexSessionRuntime(
        () => ({ rpc, close: () => {} }),
        undefined,
        (_session, event) => notices.push(event),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        64,
        undefined,
        undefined,
        {
          prepare: async (_session, client, config, deadline) =>
            capabilities.prepare({
              cwd: root,
              rpc: client,
              config,
              deadline: Math.min(deadline, Date.now() + 250),
              start: true,
              skills: [{ name: 'gestalt:xerj', path: skill, enabled: true }],
              skillsConfig: [{ path: skill, enabled: true }],
            }),
          verify: (client, thread, state) => capabilities.verify(client, thread, state),
        },
      );
      try {
        const session = RelaySession.create({
          id: 'session',
          provider: 'codex',
          workspaceId: 'w',
          workspacePath: root,
          profile: 'default',
          now: 't',
          effectiveSkillSelection: {
            skills: [{ name: 'gestalt:xerj', path: skill, enabled: true }],
          },
        }).snapshot;
        const started = await runtime.start(session, 'u');
        expect(started.threadId).toBe('same-thread');
        expect(started.effectiveSkillSelection?.skills[0]?.enabled).toBe(false);
        const starts = requests.filter((request) => request.method === 'thread/start');
        expect(starts).toHaveLength(1);
        expect(starts[0]?.params).toMatchObject({
          config: { mcp_servers: { 'gestalt-xerj': { enabled: false } } },
        });
        const observations = notices.filter((notice) => notice.method === 'gestalt/mcpStartup');
        expect(observations).toHaveLength(1);
        const event = normalizeCodexNotification(
          'session',
          1,
          '2026-10-31T00:00:00.000Z',
          observations[0]!,
        );
        expect(event?.payload).toMatchObject({
          mcpStartup: { phase: 'readiness', status: mode === 'delayed' ? 'starting' : 'failed' },
        });
        expect(JSON.stringify(event)).not.toContain('secret');
        if (mode === 'authentication-failed') {
          expect(event?.payload).toMatchObject({
            mcpStartup: {
              failure: {
                phase: 'readiness',
                readinessReason: 'authentication-failed',
                code: 'readiness-failed',
              },
            },
          });
          return;
        }
        expect((await readFile(join(root, 'calls'), 'utf8')).trim()).toBe('ensure-ready');
        await writeFile(join(root, 'release'), '');
        expect(
          await managed.check({ cwd: root, deadline: Date.now() + 1000, start: false }),
        ).toMatchObject({ status: 'ready' });
        expect(requests.filter((request) => request.method === 'thread/start')).toHaveLength(1);
        expect(requests.some((request) => request.method === 'thread/resume')).toBe(false);
        const restored = await runtime.restore(started, 'v');
        expect(restored.threadId).toBe(started.threadId);
        expect(restored.effectiveSkillSelection?.skills[0]?.enabled).toBe(true);
        expect(
          requests.find((request) => request.method === 'thread/resume')?.params,
        ).toMatchObject({
          threadId: 'same-thread',
          config: { mcp_servers: { 'gestalt-xerj': { enabled: true } } },
        });
      } finally {
        runtime.stopAll();
        await managed.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
