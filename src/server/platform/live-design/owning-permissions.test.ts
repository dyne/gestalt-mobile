/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexSessionRuntime } from '../codex/session-runtime.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import {
  livePolicyAppConfined,
  owningPermissions,
  removeRedundantLiveDenials,
} from './owning-permissions.js';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';
import { LIVE_CODEX_SHA256 } from './native-contract.js';

type Observation = Awaited<ReturnType<CodexSessionRuntime['inspectLiveAdmission']>>;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync('/tmp/live-owning-policy-');
  roots.push(root);
  const app = join(root, 'app'),
    privateRoot = join(root, 'private');
  mkdirSync(app);
  mkdirSync(privateRoot);
  const session = {
    provider: 'codex',
    threadId: 'same-root',
    model: 'selected-model',
    workspacePath: app,
    modelSettings: { reasoningEffort: 'medium' },
  } as RelaySessionSnapshot;
  // Protocol-shaped deterministic fixture; process birth/security proof is hosted separately.
  const profile: { extends: string; filesystem: Record<string, unknown> } = {
    extends: ':workspace',
    filesystem: { [privateRoot]: 'deny' },
  };
  const observation = {
    launch: { executableDigest: LIVE_CODEX_SHA256 },
    launchEnvironment: { tmpdir: '/tmp' },
    threadSelection: {
      threadId: 'same-root',
      model: 'selected-model',
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      cwd: app,
      activePermissionProfile: { id: 'live', extends: ':workspace' },
      runtimeWorkspaceRoots: [app],
      sandbox: { type: 'workspaceWrite', networkAccess: false },
    },
    configuration: {
      config: {
        permissions: { live: profile },
      },
    },
    threadConfig: {},
  } as unknown as Observation;
  return {
    session,
    observation,
    appRoot: app,
    protectedPaths: [privateRoot],
    privateRoot,
    profile,
    selection: observation.threadSelection as Record<string, unknown>,
  };
}
describe('actual owning selections to production permission admission', () => {
  it('keeps private/config denials effective without nested mask mounts, preserving reopened outputs', () => {
    const state: ManagedProjectSandboxState = {
      sandboxCwd: 'file:///app',
      useLegacyLandlock: false,
      permissionProfile: {
        type: 'managed',
        network: 'restricted',
        file_system: {
          type: 'restricted',
          entries: [
            { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
            { path: { type: 'path', path: '/private' }, access: 'deny' },
            { path: { type: 'path', path: '/private/home/config.toml' }, access: 'deny' },
            { path: { type: 'path', path: '/app' }, access: 'write' },
            { path: { type: 'path', path: '/app/.codex' }, access: 'deny' },
            { path: { type: 'path', path: '/app/.codex/AGENTS.md' }, access: 'deny' },
            { path: { type: 'path', path: '/app/control' }, access: 'deny' },
            { path: { type: 'path', path: '/app/control/previews' }, access: 'write' },
            { path: { type: 'path', path: '/app/control/previews/secret' }, access: 'deny' },
            { path: { type: 'path', path: '/app/control/previews/secret/key' }, access: 'deny' },
          ],
        },
      },
    };
    const result = removeRedundantLiveDenials(state);
    expect(result.permissionProfile.file_system.entries).toHaveLength(7);
    const access = (policy: ManagedProjectSandboxState, path: string) =>
      policy.permissionProfile.file_system.entries
        .flatMap((entry) =>
          entry.path.type === 'path' &&
          (path === entry.path.path || path.startsWith(entry.path.path + '/'))
            ? [{ length: entry.path.path.length, access: entry.access }]
            : [],
        )
        .sort((a, b) => b.length - a.length)[0]?.access;
    for (const [path, expected] of [
      ['/private/home/config.toml', 'deny'],
      ['/private/new-source', 'deny'],
      ['/app/.codex/AGENTS.md', 'deny'],
      ['/app/.codex/future-file', 'deny'],
      ['/app/control/server.json', 'deny'],
      ['/app/control/previews/index.html', 'write'],
      ['/app/control/previews/secret/key', 'deny'],
    ]) {
      expect(access(state, path!)).toBe(expected);
      expect(access(result, path!)).toBe(expected);
    }
    expect(state.permissionProfile.file_system.entries).toHaveLength(10);
    expect(result.permissionProfile.network).toBe('restricted');
  });
  it('preserves inherited enabled network when Native serializes the child option as null', () => {
    const f = fixture();
    f.selection.activePermissionProfile = { id: 'live', extends: 'parent' };
    f.selection.sandbox = { type: 'workspaceWrite', networkAccess: true };
    f.observation.configuration = {
      config: {
        sandbox_workspace_write: null,
        permissions: {
          parent: { ...f.profile, network: { enabled: true } },
          live: {
            extends: 'parent',
            description: null,
            filesystem: null,
            network: null,
            workspace_roots: null,
          },
        },
      },
    };
    expect(owningPermissions(f).state.permissionProfile.network).toBe('enabled');
  });
  it('decodes Native ConfigToml null defaults without dropping active restrictions', () => {
    const f = fixture();
    const expected = owningPermissions(f).state;
    const original = structuredClone(f.observation.configuration) as {
      config: Record<string, unknown>;
    };
    original.config.sandbox_workspace_write = null;
    const network: Record<string, unknown> = Object.fromEntries(
      [
        'enabled',
        'proxy_url',
        'enable_socks5',
        'socks_url',
        'enable_socks5_udp',
        'allow_upstream_proxy',
        'dangerously_allow_non_loopback_proxy',
        'dangerously_allow_all_unix_sockets',
        'mode',
        'domains',
        'unix_sockets',
        'allow_local_binding',
        'mitm',
      ].map((name) => [name, null]),
    );
    original.config.permissions = {
      live: {
        ...f.profile,
        description: null,
        workspace_roots: null,
        filesystem: { ...f.profile.filesystem, glob_scan_max_depth: null },
        network,
      },
    };
    f.observation.configuration = original;
    expect(owningPermissions(f).state).toEqual(expected);
    for (const [key, value] of [
      ['proxy_url', 'http://unapproved'],
      ['allow_local_binding', true],
      ['unknown_option', null],
    ] as const) {
      network[key] = value;
      expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
      delete network[key];
    }
  });
  it('preserves an originally enabled network policy and refuses disagreement with Native', () => {
    const f = fixture();
    Object.assign(f.profile, { network: { enabled: true } });
    expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
    f.selection.sandbox = { type: 'workspaceWrite', networkAccess: true };
    expect(owningPermissions(f).state.permissionProfile.network).toBe('enabled');
    Object.assign(f.profile, { network: { enabled: false } });
    expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
  });
  it('never ignores writable scratch when classifying scope and honors native inherited exclusions', () => {
    const f = fixture();
    expect(livePolicyAppConfined(owningPermissions(f).state, f.appRoot)).toBe(false);
    f.observation.configuration = {
      ...(f.observation.configuration as object),
      config: {
        permissions: { live: f.profile },
        sandbox_workspace_write: { exclude_slash_tmp: true, exclude_tmpdir_env_var: true },
      },
    };
    expect(livePolicyAppConfined(owningPermissions(f).state, f.appRoot)).toBe(true);
  });
  it('retains inherited roots, temp access, private denial and selected thinking', () => {
    const f = fixture(),
      result = owningPermissions(f);
    expect(result.state.permissionProfile.network).toBe('restricted');
    expect(result.state.permissionProfile.file_system.entries).toContainEqual({
      path: { type: 'path', path: f.appRoot },
      access: 'write',
    });
    expect(result.state.permissionProfile.file_system.entries).toContainEqual({
      path: { type: 'path', path: f.privateRoot },
      access: 'deny',
    });
    expect(result.selection.reasoningEffort).toBe('medium');
  });
  it.each(['model', 'thinking', 'provider', 'birth', 'workspace'])(
    'refuses changed %s rather than inventing selected restrictions',
    (field) => {
      const f = fixture();
      if (field === 'model') f.selection.model = 'changed-model';
      if (field === 'thinking') f.selection.reasoningEffort = 'low';
      if (field === 'provider') f.selection.modelProvider = 'kimi';
      if (field === 'birth')
        f.observation.launch = { ...f.observation.launch, executableDigest: '0'.repeat(64) };
      if (field === 'workspace') f.selection.runtimeWorkspaceRoots = ['/tmp'];
      expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
    },
  );
  it('refuses missing baseline exclusion and a more-specific grant beneath protected state', () => {
    const f = fixture(),
      filesystem = f.profile.filesystem;
    delete filesystem[f.privateRoot];
    expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
    filesystem[f.privateRoot] = 'deny';
    filesystem[join(f.privateRoot, 'future-secret')] = 'read';
    expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
  });
  it('refuses unbounded recursive deny globs, unknown access and inheritance cycles', () => {
    const f = fixture(),
      profile = f.profile;
    profile.filesystem['/tmp/**/private'] = 'deny';
    expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
    profile.filesystem.glob_scan_max_depth = 4;
    expect(owningPermissions(f).state.permissionProfile.file_system.glob_scan_max_depth).toBe(4);
    profile.filesystem['/tmp/**/private'] = 'write';
    expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
    delete profile.filesystem['/tmp/**/private'];
    profile.extends = 'live';
    f.selection.activePermissionProfile = { id: 'live', extends: 'live' };
    expect(() => owningPermissions(f)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
  });
});
