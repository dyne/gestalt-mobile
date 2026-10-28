/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import type { AvailableSkill } from '../../features/skills/model/skill-profile.js';
import { managedPlaywrightRequestSchema } from '../../../shared/contracts/managed-playwright.js';
import { profileCapabilitiesSchema } from '../../../shared/contracts/profile-capabilities.js';
import { beforeDeadline, type CodexRetrievalState } from '../retrieval/codex-xerj.js';
import {
  ManagedPlaywright,
  playwrightServerName,
  playwrightTools,
  type PlaywrightReadiness,
} from './managed-playwright.js';

type Rpc = { request(method: string, params: unknown): Promise<unknown> };
export type PlaywrightAuthority = {
  session: RelaySessionSnapshot;
  planIdentity: string | null;
  activePlanId: string | null;
  declared: boolean;
  fenced: boolean;
};
type Binding = {
  workspace: string;
  root: string | null;
  plan: string | null;
  milestone: string | null;
  rebind: boolean;
  requested: boolean;
  released: boolean;
  applied: boolean;
  connected: boolean;
  reason?: string;
  version?: string;
  packageStatus: PlaywrightReadiness['package'] | 'absent' | 'installed';
  chromeStatus: PlaywrightReadiness['chrome'];
  nodeStatus: PlaywrightReadiness['node'];
  chromeVersion: string | null;
  readinessObservedAt: string | null;
};
type Prepared = {
  binding: Binding;
  base: CodexRetrievalState;
  enabled: boolean;
  deadline: number;
  current(): boolean;
  fail(): void;
};

/** One browser owner per relay root. This is a capability adapter, not a global MCP registry. */
export class CodexPlaywright {
  private readonly bindings = new Map<string, Binding>();
  private readonly prepared = new WeakMap<CodexRetrievalState, Prepared>();
  constructor(private readonly installation: Pick<ManagedPlaywright, 'check' | 'ready'>) {}

  private async binding(authority: PlaywrightAuthority): Promise<Binding> {
    const workspace = await realpath(authority.session.workspacePath);
    const old = this.bindings.get(authority.session.id);
    if (
      old &&
      old.workspace === workspace &&
      old.root === (authority.session.threadId ?? null) &&
      old.plan === authority.planIdentity &&
      old.milestone === authority.activePlanId
    )
      return old;
    const binding: Binding = {
      workspace,
      root: authority.session.threadId ?? null,
      plan: authority.planIdentity,
      milestone: authority.activePlanId,
      rebind: old?.applied === true,
      requested: false,
      released: false,
      applied: old?.applied ?? false,
      connected: false,
      packageStatus: 'unknown',
      chromeStatus: 'unknown',
      nodeStatus: 'unknown',
      chromeVersion: null,
      readinessObservedAt: null,
    };
    this.bindings.set(authority.session.id, binding);
    return binding;
  }

  private consent(authority: PlaywrightAuthority): boolean {
    const snapshot = profileCapabilitiesSchema.safeParse(
      authority.session.effectiveSkillSelection?.capabilities,
    );
    return (
      authority.session.provider === 'codex' &&
      snapshot.success &&
      snapshot.data.playwright.enabled === true
    );
  }

  async control(authority: PlaywrightAuthority, arguments_: unknown, rootOwned: boolean) {
    const parsed = managedPlaywrightRequestSchema.safeParse(arguments_);
    if (!rootOwned || !parsed.success)
      return {
        capability: 'playwright',
        status: 'unavailable',
        reason: 'root-supervisor-required-or-invalid-request',
      };
    if (parsed.data.planId !== undefined && parsed.data.planId !== authority.activePlanId)
      return { capability: 'playwright', status: 'unavailable', reason: 'unknown-plan-id' };
    const binding = await this.binding(authority);
    if (parsed.data.action === 'stop') {
      binding.requested = false;
      binding.released = true;
      binding.reason = undefined;
    }
    if (!this.consent(authority)) {
      binding.requested = false;
      if (binding.applied)
        return {
          capability: 'playwright',
          status: 'pending',
          boundary: 'owned-runtime-resume',
          reason: 'profile-disabled',
        };
      return { capability: 'playwright', status: 'off' };
    }
    if (parsed.data.action === 'start') {
      if (authority.fenced)
        return {
          capability: 'playwright',
          status: 'unavailable',
          reason: 'manual-off-or-attention',
        };
      if (binding.reason) binding.applied = false;
      binding.requested = true;
      binding.released = false;
      binding.reason = undefined;
    }
    return this.status(binding, this.desired(authority, binding));
  }

  private desired(authority: PlaywrightAuthority, binding: Binding) {
    return (
      this.consent(authority) &&
      !authority.fenced &&
      !binding.released &&
      (binding.requested || authority.declared)
    );
  }

  private status(binding: Binding, desired: boolean) {
    const pending = binding.rebind || desired !== binding.applied;
    return {
      capability: 'playwright',
      status: pending
        ? 'pending'
        : binding.connected
          ? 'connected'
          : binding.reason
            ? 'unavailable'
            : 'idle',
      ...(pending ? { boundary: 'owned-runtime-resume' } : {}),
      ...(binding.reason ? { reason: binding.reason } : {}),
      ...(binding.version ? { packageVersion: binding.version } : {}),
      packageStatus: binding.packageStatus,
      chrome: { status: binding.chromeStatus, version: binding.chromeVersion },
      nodeStatus: binding.nodeStatus,
      readinessObservedAt: binding.readinessObservedAt,
    };
  }

  needsResume(authority: PlaywrightAuthority): boolean | Promise<boolean> {
    const existing = this.bindings.get(authority.session.id);
    const desired =
      this.consent(authority) &&
      !authority.fenced &&
      !existing?.released &&
      (existing?.requested || authority.declared);
    // Browser-off chat must not acquire a filesystem/readiness dependency or
    // an extra asynchronous boundary on every Autopilot root continuation.
    if (!desired && !existing?.applied && !existing?.rebind) return false;
    if (
      existing &&
      !existing.rebind &&
      existing.workspace === authority.session.workspacePath &&
      existing.root === authority.session.threadId &&
      existing.plan === authority.planIdentity &&
      existing.milestone === authority.activePlanId &&
      desired === existing.applied
    )
      return false;
    return this.binding(authority).then(
      (binding) => binding.rebind || this.desired(authority, binding) !== binding.applied,
    );
  }

  /** Called only at thread start/resume. Native app-server owns the managed stdio child. */
  async prepare(
    base: CodexRetrievalState,
    authority: PlaywrightAuthority,
    input: {
      rpc: Rpc;
      skills: readonly AvailableSkill[];
      deadline: number;
      current?: () => PlaywrightAuthority;
    },
  ): Promise<CodexRetrievalState> {
    const binding = await this.binding(authority);
    const current = () => {
      const now = input.current?.() ?? authority;
      return (
        this.bindings.get(authority.session.id) === binding &&
        now.session.id === authority.session.id &&
        now.session.workspacePath === authority.session.workspacePath &&
        ((now.session.threadId ?? null) === (authority.session.threadId ?? null) ||
          now.session.threadId === binding.root) &&
        now.planIdentity === authority.planIdentity &&
        now.activePlanId === authority.activePlanId &&
        this.consent(now) === this.consent(authority) &&
        now.fenced === authority.fenced
      );
    };
    const skill = input.skills.find((entry) => entry.name === 'gestalt:playwright');
    let native: Record<string, unknown> = {};
    let compatible = false;
    try {
      const response = (await beforeDeadline(
        input.rpc.request('config/read', { includeLayers: false }),
        input.deadline,
      )) as { config?: Record<string, unknown> };
      native = response.config ?? {};
      compatible = !!response.config;
    } catch {
      /* Optional capability stays unavailable. */
    }
    const servers = omitUnset(native.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
    const reserved = servers[playwrightServerName] ?? {};
    const mcp: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(servers)) {
      if (
        Array.isArray(server?.args) &&
        server.args[0] === 'playwright' &&
        server.args[1] === 'mcp'
      )
        mcp[name] = { ...server, enabled: false, required: false };
    }
    const rules = native.skills as
      | {
          include_instructions?: boolean;
          config?: { name?: string; path?: string; enabled?: boolean }[];
        }
      | undefined;
    let enabled = false,
      guidance = '',
      manager = 'gestalt';
    const options: string[] = [];
    binding.connected = false;
    binding.reason = undefined;
    if (this.desired(authority, binding)) {
      binding.reason = 'installation-or-runtime-unavailable';
      binding.packageStatus = 'unknown';
      binding.chromeStatus = 'unknown';
      binding.nodeStatus = 'unknown';
      binding.chromeVersion = null;
      binding.readinessObservedAt = null;
      try {
        const install = await beforeDeadline(this.installation.check(), input.deadline);
        binding.packageStatus = install.status;
        binding.readinessObservedAt = new Date().toISOString();
        if (install.status === 'installed') {
          manager = install.manager;
          binding.version = install.version;
          let validArgs = true;
          if (reserved.args !== undefined) {
            const args = reserved.args;
            validArgs = Array.isArray(args) && args[0] === 'playwright' && args[1] === 'mcp';
            if (validArgs)
              for (let i = 2; i < (args as string[]).length; i += 2) {
                const option = (args as string[])[i],
                  value = (args as string[])[i + 1];
                if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
                  validArgs = false;
                  break;
                }
                if (option === '--cwd' && (await realpath(value)) === binding.workspace) continue;
                if (option !== '--executable-path' || !isAbsolute(value) || options.length) {
                  validArgs = false;
                  break;
                }
                options.push(option, value);
              }
          }
          const conflict =
            reserved.enabled === false ||
            reserved.url !== undefined ||
            (reserved.command !== undefined && reserved.command !== manager) ||
            reserved.env !== undefined ||
            (Array.isArray(reserved.env_vars) && reserved.env_vars.length > 0);
          if (
            compatible &&
            skill &&
            rules?.include_instructions !== false &&
            rules?.config
              ?.filter((rule) => rule.name === skill.name || rule.path === skill.path)
              .at(-1)?.enabled !== false &&
            !conflict &&
            validArgs
          ) {
            guidance = await beforeDeadline(readFile(skill.path, 'utf8'), input.deadline);
            if (guidance.length <= 16_384) {
              const readiness = await beforeDeadline(
                this.installation.ready(manager, binding.workspace, input.deadline, options),
                input.deadline,
              );
              enabled = readiness.ready;
              binding.packageStatus =
                readiness.package === 'unknown' ? 'installed' : readiness.package;
              binding.chromeStatus = readiness.chrome;
              binding.chromeVersion = readiness.chromeVersion;
              binding.nodeStatus = readiness.node;
              binding.readinessObservedAt = new Date().toISOString();
            }
          }
        }
      } catch {
        /* No installer, config repair or shell fallback. */
      }
      if (enabled) binding.reason = undefined;
    }
    if (!current()) {
      enabled = false;
      binding.reason = 'authority-changed';
    }
    binding.applied = this.desired(authority, binding);
    binding.rebind = false;
    const disabled = {
      command: manager,
      args: ['playwright', 'mcp', '--cwd', binding.workspace, ...options],
      cwd: binding.workspace,
      enabled: false,
      required: false,
    };
    let available = enabled;
    const state: CodexRetrievalState = {
      get ready() {
        return base.ready || available;
      },
      deadline: Math.max(base.deadline, input.deadline),
      repositories: base.repositories,
      get capabilities() {
        return [
          ...(base.capabilities ?? []),
          {
            skillName: 'gestalt:playwright',
            serverName: playwrightServerName,
            ready: binding.connected && current(),
            diagnostic: binding.reason,
          },
        ];
      },
      get skillsConfig() {
        return base.skillsConfig.map((entry) =>
          entry.path === skill?.path ? { ...entry, enabled: false } : entry,
        );
      },
      get config() {
        return {
          ...base.config,
          mcp_servers: {
            ...(base.config.mcp_servers as object),
            ...mcp,
            [playwrightServerName]: available
              ? {
                  ...reserved,
                  ...disabled,
                  enabled: true,
                  env_vars: ['GESTALT_HOME'],
                  startup_readiness: 'connection',
                  startup_timeout_ms: Math.max(1, input.deadline - Date.now()),
                }
              : disabled,
          },
          skills: {
            config: [
              ...((base.config.skills as { config?: unknown[] })?.config ?? []),
              { name: 'gestalt:playwright', enabled: false },
            ],
          },
          developer_instructions: `${base.config.developer_instructions ?? ''}\n<gestalt_playwright_unavailable>Browser guidance is inactive until this host verifies connected standard tools. Use gestalt_managed_playwright for session-scoped requests. Installation or a plan declaration never grants consent. Pending activation requires a safe owned-runtime resume.</gestalt_playwright_unavailable>`,
        };
      },
      // Each verifier already disables only its failed connection. A shared
      // fallback must not disable a healthy browser after an XERJ/Serena failure.
      fallback() {},
      get turnInstructions() {
        return binding.connected && current()
          ? `<gestalt_playwright_capability>Verified managed browser tools are connected. Host MCP approvals apply; shell sandbox roots do not confine this browser.\n${guidance}\n</gestalt_playwright_capability>`
          : '';
      },
    };
    this.prepared.set(state, {
      binding,
      base,
      enabled,
      deadline: input.deadline,
      current,
      fail() {
        available = false;
        binding.connected = false;
      },
    });
    return state;
  }

  async verify(rpc: Rpc, threadId: string, state: CodexRetrievalState): Promise<boolean> {
    const prepared = this.prepared.get(state);
    if (!prepared?.enabled) return true;
    try {
      while (Date.now() < prepared.deadline) {
        const result = (await beforeDeadline(
          rpc.request('mcpServerStatus/list', {
            threadId,
            serverName: playwrightServerName,
            detail: 'full',
          }),
          prepared.deadline,
        )) as {
          data?: {
            name?: string;
            runtimeStatus?: string;
            toolsError?: string;
            tools?: Record<string, unknown>;
          }[];
        };
        const server = result.data?.find((entry) => entry.name === playwrightServerName);
        if (
          prepared.current() &&
          server?.runtimeStatus === 'connected' &&
          !server.toolsError &&
          playwrightTools.every((tool) => Object.hasOwn(server.tools ?? {}, tool))
        ) {
          prepared.binding.connected = true;
          prepared.binding.root = threadId;
          return true;
        }
        if (server?.runtimeStatus !== 'starting') break;
        await beforeDeadline(new Promise((resolve) => setTimeout(resolve, 25)), prepared.deadline);
      }
    } catch {
      /* Keep chat, XERJ and Serena usable. */
    }
    prepared.binding.reason = 'connection-or-tools-unavailable';
    prepared.fail();
    return false;
  }

  release(sessionId: string): void {
    this.bindings.delete(sessionId);
  }
  /** The runtime binds even an unavailable fresh capability to its actual root.
   * Otherwise a failed fresh declaration looks like a fork at the first turn
   * and requests a resume before Codex has created a durable rollout. */
  bound(state: CodexRetrievalState, threadId: string): void {
    const prepared = this.prepared.get(state);
    if (prepared) prepared.binding.root = threadId;
  }
  observe(sessionId: string, notification: { method: string; params: unknown }): void {
    if (
      !['mcpServer/statusUpdated', 'mcpServer/startupStatus/updated'].includes(notification.method)
    )
      return;
    const value = notification.params as {
      name?: unknown;
      threadId?: unknown;
      status?: unknown;
    } | null;
    const binding = this.bindings.get(sessionId);
    if (
      !binding ||
      value?.name !== playwrightServerName ||
      (value.threadId && value.threadId !== binding.root) ||
      !['failed', 'cancelled', 'disconnected'].includes(String(value.status))
    )
      return;
    binding.connected = false;
    binding.reason = 'connection-or-tools-unavailable';
  }
  base(state: CodexRetrievalState): CodexRetrievalState {
    return this.prepared.get(state)?.base ?? state;
  }
}

function omitUnset(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUnset);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .map(([key, entry]) => [key, omitUnset(entry)]),
    );
  return value;
}
