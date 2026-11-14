/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexCapabilities } from './codex-capabilities.js';
import { CodexSerena } from './codex-serena.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(native: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'mobile-legacy-capability-'));
  roots.push(root);
  const manager = join(root, 'gestalt');
  await writeFile(manager, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  vi.stubEnv('GESTALT_MANAGER_BIN', manager);
  const persisted = join(root, 'config.json');
  await writeFile(persisted, JSON.stringify(native));
  const request = vi.fn(async (method: string) => {
    if (method !== 'config/read') throw new Error('Unexpected native operation');
    return { config: native };
  });
  const check = vi.fn(async () => ({ status: 'absent' as const }));
  const pair = new CodexCapabilities(new CodexSerena({ check }));
  const input = {
    cwd: root,
    rpc: { request },
    deadline: Date.now() + 1000,
    skills: [],
    skillsConfig: [],
    config: {},
    start: true,
  };
  return { root, manager, persisted, request, check, pair, input };
}

it.each([false, true])(
  'retires complete legacy instructions in the actual prepare flow; fresh %s',
  async (startup) => {
    const legacy = '<gestalt_xerj_capability>Old search instructions</gestalt_xerj_capability>';
    const unavailable = '<gestalt_xerj_unavailable>Old fallback</gestalt_xerj_unavailable>';
    const retained =
      'User prose\n<gestalt_playwright_unavailable>Retained browser block</gestalt_playwright_unavailable>\n';
    const partial = '<gestalt_xerj_capability>Unclosed user text';
    const scalar = retained + legacy + unavailable + partial;
    const native = { developer_instructions: scalar, mcp_servers: {} };
    const f = await fixture(native);
    const before = await readFile(f.persisted, 'utf8');
    for (const explicit of [false, true]) {
      const state = await f.pair.prepare({
        ...f.input,
        startup,
        config: explicit ? { developer_instructions: scalar } : {},
      });
      const text = String(state.config.developer_instructions);
      expect(text).toContain(retained + partial);
      expect(text).not.toContain('Old search instructions');
      expect(text).not.toContain('Old fallback');
      const repeated = await f.pair.prepare({ ...f.input, startup, config: state.config });
      expect(repeated.config.developer_instructions).toBe(text);
      expect(native.developer_instructions).toBe(scalar);
      expect(await readFile(f.persisted, 'utf8')).toBe(before);
    }
  },
);

it.each([
  ['gestalt-xerj', ['xerj', 'mcp']],
  ['renamed-connection', ['xerj', 'mcp']],
  ['thread-connection', ['xerj', 'mcp', '--url', 'http://127.0.0.1:19200']],
] as const)(
  'rejects proven legacy managed MCP %s before any service preparation',
  async (name, args) => {
    const native: Record<string, unknown> = { mcp_servers: {} };
    const f = await fixture(native);
    const alias = join(f.root, 'manager-link');
    await symlink(f.manager, alias);
    native.mcp_servers = {
      [name]: { command: alias, args: [...args], enabled: true, required: true },
    };
    await writeFile(f.persisted, JSON.stringify(native));
    const before = await readFile(f.persisted, 'utf8');
    await expect(f.pair.prepare(f.input)).rejects.toThrow('Run gestalt update');
    expect(f.request.mock.calls.map(([method]) => method)).toEqual(['config/read']);
    expect(f.check).not.toHaveBeenCalled();
    expect(await readFile(f.persisted, 'utf8')).toBe(before);
  },
);

it.each([
  'different executable',
  'extra args',
  'remote transport',
  'unresolved executable',
  'disabled',
  'invalid endpoint',
  'manager identity unavailable',
])('preserves unproven or inactive same-name service: %s', async (kind) => {
  const native: Record<string, unknown> = { mcp_servers: {} };
  const f = await fixture(native);
  const server = {
    command: f.manager,
    args: ['xerj', 'mcp'],
    enabled: kind !== 'disabled',
    ...(kind === 'remote transport' ? { url: 'http://localhost:1234' } : {}),
  };
  if (kind === 'different executable') {
    server.command = join(f.root, 'custom-server');
    await writeFile(server.command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  if (kind === 'extra args') server.args.push('--custom');
  if (kind === 'unresolved executable') server.command = join(f.root, 'missing');
  if (kind === 'invalid endpoint') server.args.push('--url', 'http://127.0.0.1:99999');
  if (kind === 'manager identity unavailable')
    vi.stubEnv('GESTALT_MANAGER_BIN', join(f.root, 'missing-manager'));
  native.mcp_servers = { 'gestalt-xerj': server };
  const before = JSON.stringify(native);
  const state = await f.pair.prepare(f.input);
  expect(state.config.mcp_servers).not.toHaveProperty('gestalt-xerj');
  expect(JSON.stringify(native)).toBe(before);
  expect(f.request).toHaveBeenCalledOnce();
});

it.each([
  '<gestalt_xerj_capability>Unclosed',
  'Unopened</gestalt_xerj_unavailable>',
  '<gestalt_xerj_capability>Outer<gestalt_xerj_capability>Inner</gestalt_xerj_capability>Tail</gestalt_xerj_capability>',
  '<gestalt_xerj_capability>Unclosed outer<gestalt_xerj_unavailable>User nested content</gestalt_xerj_unavailable>',
  '<gestalt_xerj_capability>Unclosed outer<gestalt_xerj_capability>User nested content</gestalt_xerj_capability>',
])('preserves incomplete or nested legacy markers byte for byte: %s', async (scalar) => {
  const f = await fixture({ developer_instructions: scalar });
  const state = await f.pair.prepare({ ...f.input, startup: false });
  expect(String(state.config.developer_instructions).startsWith(scalar)).toBe(true);
  const repeated = await f.pair.prepare({ ...f.input, config: state.config });
  expect(repeated.config.developer_instructions).toBe(state.config.developer_instructions);
});

it('guards explicit restore overrides and resolves the established manager on PATH', async () => {
  const f = await fixture({ mcp_servers: {} });
  vi.stubEnv('GESTALT_MANAGER_BIN', '');
  vi.stubEnv('PATH', f.root);
  const override = { mcp_servers: { alias: { command: f.manager, args: ['xerj', 'mcp'] } } };
  const before = JSON.stringify(override);
  await expect(f.pair.prepare({ ...f.input, config: override, startup: false })).rejects.toThrow(
    'Run gestalt update',
  );
  expect(JSON.stringify(override)).toBe(before);
  expect(f.request).toHaveBeenCalledOnce();
});
