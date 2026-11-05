/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareStartupGuidance } from './startup-guidance.js';
import {
  installStartupFixture,
  startupDescriptor,
  syntheticBlock,
  syntheticBootstrap,
} from './startup-guidance.fixture.js';
import { CodexCapabilities } from './codex-capabilities.js';
import { CodexSerena } from './codex-serena.js';
import { CodexXerj, xerjTools } from '../retrieval/codex-xerj.js';
import { serenaTools } from './managed-serena.js';
import { CodexSessionRuntime, type AppServer } from './session-runtime.js';
import { RelaySession } from '../../features/sessions/model/relay-session.js';
import { CodexPlaywright } from './codex-playwright.js';
import { withCapabilityInstructions } from './instruction-blocks.js';
import { CodexSkillCatalog } from '../skills/codex-skill-catalog.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const count = (text: string, needle: string) => text.split(needle).length - 1;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mobile startup '));
  roots.push(root);
  const packageRoot = join(root, 'installed/gestalt/0.0.1');
  const skills = await installStartupFixture(packageRoot);
  const input = {
    instructions: 'CUSTOM_GUIDANCE\n',
    native: {},
    skills,
    skillsConfig: skills.map(({ path, enabled }) => ({ path, enabled })),
  };
  return { root, packageRoot, input };
}

describe('selected installed startup contract', () => {
  it.each([
    '',
    'CUSTOM_GUIDANCE\n',
    `ROLE_DUTIES\n${syntheticBlock}\nTAIL`,
    `${syntheticBlock}\n${syntheticBlock}`,
  ])('preserves outside bytes and normalizes one owned block for %j', async (instructions) => {
    const f = await fixture();
    const prepared = await prepareStartupGuidance({ ...f.input, instructions });
    expect(prepared.startup).toMatchObject({
      status: 'ready',
      packageVersion: '0.0.1',
      blockVersion: 1,
    });
    expect(count(prepared.instructions, syntheticBootstrap)).toBe(1);
    if (instructions.startsWith('CUSTOM'))
      expect(prepared.instructions.startsWith(instructions)).toBe(true);
    if (instructions.startsWith('ROLE')) expect(prepared.instructions).toBe(instructions);
    expect(
      await prepareStartupGuidance({ ...f.input, instructions: prepared.instructions }),
    ).toEqual(prepared);
  });
  it.each([
    'missing',
    'unsupported',
    'invalid',
    'source-missing',
    'malformed-block',
    'newer-block',
    'nested-block',
  ])('preserves original instructions with bounded %s fallback', async (scenario) => {
    const f = await fixture();
    const descriptor = join(f.packageRoot, 'gestalt-startup-contract.json');
    if (scenario === 'missing') await rm(descriptor);
    if (scenario === 'unsupported')
      await writeFile(descriptor, JSON.stringify({ ...startupDescriptor, blockVersion: 99 }));
    if (scenario === 'invalid')
      await writeFile(descriptor, JSON.stringify({ ...startupDescriptor, source: '../elsewhere' }));
    if (scenario === 'source-missing') await rm(join(f.packageRoot, 'startup/bootstrap.md'));
    if (scenario === 'malformed-block') f.input.instructions += '<!-- gestalt:startup:v1 -->';
    if (scenario === 'newer-block') f.input.instructions += syntheticBlock.replace(':v1', ':v2');
    if (scenario === 'nested-block')
      f.input.instructions += syntheticBlock.replace(syntheticBootstrap, syntheticBlock);
    const result = await prepareStartupGuidance(f.input);
    expect(result.instructions).toBe(f.input.instructions);
    expect(result.startup).toMatchObject({
      status: 'unavailable',
      reason:
        scenario === 'missing'
          ? 'missing-contract'
          : scenario === 'unsupported'
            ? 'unsupported-contract'
            : 'invalid-contract',
    });
    expect(JSON.stringify(result.startup)).not.toContain('CUSTOM_GUIDANCE');
    expect(JSON.stringify(result.startup)).not.toContain(f.root);
  });
  it.each(['instructions', 'selection', 'native-rule'])('respects excluded %s', async (mode) => {
    const f = await fixture();
    const input = {
      ...f.input,
      native:
        mode === 'instructions'
          ? { skills: { include_instructions: false } }
          : mode === 'native-rule'
            ? {
                skills: {
                  config: f.input.skills.map((skill) => ({ name: skill.name, enabled: false })),
                },
              }
            : {},
      skillsConfig:
        mode === 'selection'
          ? f.input.skillsConfig.map((skill) => ({ ...skill, enabled: false }))
          : [],
    };
    expect(await prepareStartupGuidance(input)).toEqual({
      instructions: f.input.instructions,
      startup: { status: 'unavailable', reason: 'excluded' },
    });
  });
  it('uses the selected version and refuses ambiguous discoveries instead of guessing the newest cache', async () => {
    const f = await fixture();
    const other = await installStartupFixture(join(f.root, 'installed/gestalt/9.9.9'), '9.9.9');
    expect((await prepareStartupGuidance(f.input)).startup.packageVersion).toBe('0.0.1');
    expect(
      (
        await prepareStartupGuidance({
          ...f.input,
          skills: [f.input.skills[0], other[0]],
          skillsConfig: [],
        })
      ).startup.reason,
    ).toBe('ambiguous-selected-package');
  });
  it('changes only complete capability-owned blocks even when the requested block is missing', () => {
    const unrelated = '<unrelated>Keep <gestalt_serena_ literal</unrelated>\n';
    const block = '<gestalt_serena_unavailable>Unavailable</gestalt_serena_unavailable>';
    const once = withCapabilityInstructions(unrelated, 'serena', block);
    expect(once).toBe(unrelated + '\n' + block);
    expect(withCapabilityInstructions(once, 'serena', block)).toBe(once);
    expect(withCapabilityInstructions(once + block, 'serena', block)).toBe(once);
  });
});

describe('fresh runtime startup delivery', () => {
  it.each([false, true])(
    'preserves native scalar precedence after failed readback; explicit input scalar: %s',
    async (explicit) => {
      const f = await fixture();
      const requests: Array<{ method: string; params: unknown }> = [];
      const rpc: AppServer['rpc'] = {
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === 'config/read') throw new Error('Synthetic readback unavailable');
          if (method === 'thread/start') return { thread: { id: 'readback-fallback' } };
          return {};
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      };
      const xerjCheck = vi.fn(),
        serenaCheck = vi.fn();
      const pair = new CodexCapabilities(
        new CodexXerj({ check: xerjCheck }),
        new CodexSerena({ check: serenaCheck }),
      );
      const browser = new CodexPlaywright({ check: vi.fn(), ready: vi.fn() });
      const session = RelaySession.create({
        id: 'fallback',
        provider: 'codex',
        workspaceId: 'w',
        workspacePath: f.root,
        profile: 'default',
        effectiveSkillSelection: { skills: f.input.skills },
        now: 't',
      }).snapshot;
      const runtime = new CodexSessionRuntime(
        () => ({ rpc, close() {} }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        64,
        undefined,
        async () => (explicit ? { developer_instructions: 'EXPLICIT_SCALAR' } : {}),
        {
          prepare: async (session, rpc, config, deadline) => {
            const base = await pair.prepare({
              cwd: f.root,
              rpc,
              config,
              deadline,
              start: true,
              startup: true,
              skills: f.input.skills,
              skillsConfig: f.input.skillsConfig,
            });
            expect(base.startup).toEqual({
              status: 'unavailable',
              reason: 'native-config-unavailable',
            });
            expect(base.ready).toBe(false);
            return browser.prepare(
              base,
              { session, planIdentity: null, activePlanId: null, declared: false, fenced: false },
              { rpc, skills: f.input.skills, deadline },
            );
          },
          verify: (rpc, thread, state) => pair.verify(rpc, thread, browser.base(state)),
        },
      );
      try {
        await runtime.start(session, 't');
        const sent = requests.find((request) => request.method === 'thread/start')!.params as {
          config: Record<string, unknown>;
        };
        if (explicit) expect(sent.config.developer_instructions).toContain('EXPLICIT_SCALAR');
        else expect(sent.config).not.toHaveProperty('developer_instructions');
        expect(sent).not.toHaveProperty('developerInstructions');
        expect(sent).not.toHaveProperty('baseInstructions');
        expect(sent.config).toMatchObject({
          mcp_servers: {
            'gestalt-xerj': { enabled: false },
            'gestalt-serena': { enabled: false },
            'gestalt-playwright': { enabled: false },
          },
        });
        expect(xerjCheck).not.toHaveBeenCalled();
        expect(serenaCheck).not.toHaveBeenCalled();
      } finally {
        runtime.stopAll();
      }
    },
  );
  it.each(['both', 'xerj', 'serena', 'neither'])(
    'sends preserved config and independent %s capabilities with one stable block',
    async (availability) => {
      const f = await fixture();
      const requests: Array<{ method: string; params: unknown }> = [];
      const native = {
        developer_instructions: 'CUSTOM_NATIVE',
        features: { hooks: true },
        personality: 'pragmatic',
        model_instructions_file: '/synthetic/foundation.md',
        mcp_servers: {},
      };
      let starts = 0;
      const rpc: AppServer['rpc'] = {
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === 'config/read') return { config: native };
          if (method === 'thread/start') return { thread: { id: `root-${++starts}` } };
          return {
            data: [
              {
                name: 'gestalt-xerj',
                runtimeStatus: 'connected',
                tools: Object.fromEntries(xerjTools.map((tool) => [tool, {}])),
              },
              {
                name: 'gestalt-serena',
                runtimeStatus: 'connected',
                tools: Object.fromEntries(serenaTools.map((tool) => [tool, {}])),
              },
            ],
          };
        },
        onNotification: () => () => {},
        onServerRequest: () => () => {},
      };
      const pair = new CodexCapabilities(
        new CodexXerj({
          check: async () =>
            availability === 'both' || availability === 'xerj'
              ? {
                  status: 'ready',
                  manager: '/synthetic/manager',
                  endpoint: 'http://127.0.0.1:19200',
                }
              : { status: 'absent' },
        }),
        new CodexSerena({
          check: async () =>
            availability === 'both' || availability === 'serena'
              ? { status: 'installed', manager: '/synthetic/manager', version: '0.0.1' }
              : { status: 'absent' },
        }),
      );
      const browser = new CodexPlaywright({ check: vi.fn(), ready: vi.fn() });
      const session = {
        ...RelaySession.create({
          id: 'root',
          provider: 'codex',
          workspaceId: 'w',
          workspacePath: f.root,
          profile: 'default',
          model: 'selected-model',
          effectiveSkillSelection: { skills: f.input.skills },
          now: 't',
        }).snapshot,
        executionPolicy: { approvalPolicy: 'never' as const, sandbox: 'read-only' as const },
      };
      const runtime = new CodexSessionRuntime(
        () => ({ rpc, close: () => {} }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        64,
        undefined,
        async () => ({ model_reasoning_effort: 'medium' }),
        {
          prepare: async (session, rpc, config, deadline) =>
            browser.prepare(
              await pair.prepare({
                cwd: session.workspacePath,
                rpc,
                config,
                deadline,
                start: true,
                startup: !session.threadId,
                skills: f.input.skills,
                skillsConfig: f.input.skillsConfig,
              }),
              { session, planIdentity: null, activePlanId: null, declared: false, fenced: false },
              { rpc, skills: f.input.skills, deadline },
            ),
          verify: (rpc, thread, state) => pair.verify(rpc, thread, browser.base(state)),
        },
      );
      try {
        await runtime.start(session, 't');
        const sent = requests.find((request) => request.method === 'thread/start')!.params as {
          config: Record<string, unknown>;
        };
        expect(sent).toMatchObject({
          approvalPolicy: 'never',
          sandbox: 'read-only',
          model: 'selected-model',
          config: { model_reasoning_effort: 'medium' },
        });
        expect(sent).not.toHaveProperty('baseInstructions');
        expect(sent).not.toHaveProperty('developerInstructions');
        expect(sent.config).not.toHaveProperty('personality');
        expect(sent.config).not.toHaveProperty('model_instructions_file');
        const text = String(sent.config.developer_instructions);
        expect(count(text, 'CUSTOM_NATIVE')).toBe(1);
        expect(count(text, syntheticBootstrap)).toBe(1);
        expect(count(text, '<gestalt_playwright_unavailable>')).toBe(1);
        expect(text).toContain(
          `<gestalt_xerj_${availability === 'both' || availability === 'xerj' ? 'capability' : 'unavailable'}>`,
        );
        expect(text).toContain(
          `<gestalt_serena_${availability === 'both' || availability === 'serena' ? 'capability' : 'unavailable'}>`,
        );
      } finally {
        runtime.stopAll();
      }
    },
  );
  it('keeps repeated prepare/verify fallback idempotent without removing unrelated guidance', async () => {
    const f = await fixture();
    const pair = new CodexCapabilities(
      new CodexXerj({
        check: async () => ({
          status: 'ready',
          manager: '/synthetic/manager',
          endpoint: 'http://127.0.0.1:19200',
        }),
      }),
      new CodexSerena({ check: async () => ({ status: 'absent' }) }),
    );
    const rpc = {
      request: async (method: string) =>
        method === 'config/read'
          ? { config: { developer_instructions: 'CUSTOM\n<unrelated>Keep</unrelated>' } }
          : { data: [] },
    };
    const input = {
      ...f.input,
      rpc,
      cwd: f.root,
      deadline: Date.now() + 1000,
      config: {},
      start: true,
      startup: true,
    };
    const first = await pair.prepare(input);
    expect(await pair.verify(rpc, 'unpublished', first)).toBe(false);
    const text = String(first.config.developer_instructions);
    const second = await pair.prepare({ ...input, config: first.config });
    expect(await pair.verify(rpc, 'unpublished', second)).toBe(false);
    expect(second.config.developer_instructions).toBe(text);
    expect(count(text, syntheticBootstrap)).toBe(1);
    expect(text).toContain('CUSTOM\n<unrelated>Keep</unrelated>');
  });
  it('keeps ephemeral catalog probes free of stable bootstrap and durable role duties', async () => {
    const f = await fixture();
    const requests: Array<{ method: string; params: unknown }> = [];
    const pair = new CodexCapabilities(
      new CodexXerj({
        check: async () => ({
          status: 'ready',
          manager: '/synthetic/manager',
          endpoint: 'http://127.0.0.1:19200',
        }),
      }),
      new CodexSerena({ check: async () => ({ status: 'absent' }) }),
    );
    const catalog = new CodexSkillCatalog(
      'default',
      () => ({
        close() {},
        rpc: {
          request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'skills/list')
              return {
                data: [
                  {
                    cwd: f.root,
                    skills: f.input.skills.map((skill) => ({
                      ...skill,
                      description: 'Synthetic skill',
                    })),
                    errors: [],
                  },
                ],
              };
            if (method === 'config/read') return { config: {} };
            if (method === 'thread/start') return { thread: { id: 'probe' } };
            return {
              data: [
                {
                  name: 'gestalt-xerj',
                  runtimeStatus: 'connected',
                  tools: Object.fromEntries(xerjTools.map((tool) => [tool, {}])),
                },
              ],
            };
          },
        },
      }),
      1000,
      pair,
    );
    await catalog.list(f.root);
    const sent = requests.find((request) => request.method === 'thread/start')!.params;
    expect(sent).toMatchObject({ ephemeral: true });
    expect(JSON.stringify(sent)).not.toContain(syntheticBootstrap);
    expect(JSON.stringify(sent)).not.toContain('ROLE_DUTIES');
    expect(await readFile(join(f.packageRoot, 'startup/bootstrap.md'), 'utf8')).toBe(
      syntheticBootstrap,
    );
    // No preparation allocates provider state or scratch ownership.
    await expect(readFile(join(f.root, 'tmp/sessions/.gestalt-owner.json'))).rejects.toThrow();
  });
});
