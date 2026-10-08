/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';
import {
  beforeDeadline,
  type CodexRetrievalState,
  type CodexXerj,
} from '../retrieval/codex-xerj.js';
import { ManagedSerena, serenaTools } from './managed-serena.js';

export const serenaServerName = 'gestalt-serena';
type Input = Parameters<CodexXerj['prepare']>[0];
type Rpc = Input['rpc'];

// config/read includes unset defaults as null. Thread overrides cannot encode
// those as TOML values; retain explicit settings, including tool approvals.
function omitUnsetConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUnsetConfig);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .map(([key, entry]) => [key, omitUnsetConfig(entry)]),
    );
  return value;
}

/** Connection availability only. Native model calls establish effective sandbox authority. */
export class CodexSerena {
  constructor(private readonly installation: Pick<ManagedSerena, 'check'> = new ManagedSerena()) {}

  async prepare(input: Input): Promise<CodexRetrievalState> {
    const skill = input.skills.find((entry) => entry.name === 'gestalt:serena');
    let native: Record<string, unknown> = {};
    let compatible = false;
    try {
      const read = (await beforeDeadline(
        input.rpc.request('config/read', { includeLayers: false }),
        input.deadline,
      )) as { config?: Record<string, unknown> };
      native = read.config ?? {};
      compatible = read.config !== undefined;
    } catch {
      /* Fail closed on an incompatible runtime. */
    }
    const servers = omitUnsetConfig(native.mcp_servers ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const reserved = servers[serenaServerName] ?? {};
    const mcp: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(servers)) {
      const args = server?.args as string[] | undefined;
      if (args?.[0] === 'serena' && args[1] === 'mcp')
        mcp[name] = { ...server, enabled: false, required: false };
    }
    const instructions =
      typeof native.developer_instructions === 'string' ? native.developer_instructions : '';
    const state: CodexRetrievalState = {
      ready: false,
      deadline: input.deadline,
      config: {},
      skillsConfig: input.skillsConfig,
      fallback: () => {
        state.ready = false;
        state.skillsConfig = input.skillsConfig.map((entry) => ({
          ...entry,
          enabled: entry.path === skill?.path ? false : entry.enabled,
        }));
        state.config = {
          ...input.config,
          skills: { config: [{ name: 'gestalt:serena', enabled: false }] },
          mcp_servers: {
            ...mcp,
            // Disabled entries still require a transport in Codex. Keep this
            // override on resume so a previous thread connection stays disabled.
            [serenaServerName]: {
              ...reserved,
              ...(reserved.command || reserved.url
                ? {}
                : { command: 'gestalt', args: ['serena', 'mcp', '--cwd', input.cwd] }),
              enabled: false,
              required: false,
            },
          },
          developer_instructions: `${instructions}\n<gestalt_serena_unavailable>\nSerena is unavailable in this runtime. Earlier Serena guidance is inactive; use native code tools.\n</gestalt_serena_unavailable>`,
        };
      },
    };
    state.fallback();
    const rules = native.skills as
      | {
          config?: Array<{ name?: string; path?: string; enabled?: boolean }>;
          include_instructions?: boolean;
        }
      | undefined;
    const selected = input.skillsConfig.find((entry) => entry.path === skill?.path);
    const conflict =
      reserved.enabled === false ||
      (reserved.env && Object.keys(reserved.env).length) ||
      reserved.enabled_tools ||
      (reserved.disabled_tools as unknown[] | undefined)?.length ||
      Object.values((reserved.tools ?? {}) as Record<string, { enabled?: boolean }>).some(
        (tool) => tool.enabled !== undefined,
      );
    if (
      !compatible ||
      !skill ||
      !selected?.enabled ||
      rules?.include_instructions === false ||
      (native.features as { hooks?: boolean } | undefined)?.hooks !== true ||
      rules?.config?.filter((rule) => rule.name === skill.name || rule.path === skill.path).at(-1)
        ?.enabled === false ||
      conflict ||
      Date.now() >= input.deadline
    )
      return state;
    try {
      const install = await beforeDeadline(this.installation.check(), input.deadline);
      if (install.status !== 'installed') {
        state.diagnostic = 'installation-unavailable';
        return state;
      }
      const guidance = await beforeDeadline(readFile(skill.path, 'utf8'), input.deadline);
      if (guidance.length > 16_384) return state;
      state.config = {
        ...input.config,
        skills: { config: [{ name: 'gestalt:serena', enabled: true }] },
        mcp_servers: {
          ...mcp,
          [serenaServerName]: {
            ...reserved,
            command: install.manager,
            args: ['serena', 'mcp', '--cwd', input.cwd],
            cwd: input.cwd,
            env_vars: ['CODEX_HOME', 'GESTALT_HOME'],
            enabled: true,
            required: false,
            startup_readiness: 'connection',
            startup_timeout_ms: Math.max(1, input.deadline - Date.now()),
          },
        },
        developer_instructions: `${instructions}\n<gestalt_serena_capability>\nSerena is bound to this workspace. Connection and listed tools do not prove language readiness. First call get_symbols_overview on a current project source file and verify success before semantic editing; on failure use native code tools. Native session and child permissions and approvals apply. Plan mode prohibits edits. Do not switch projects or modes.\n${guidance}\n</gestalt_serena_capability>`,
      };
      state.skillsConfig = input.skillsConfig;
      state.ready = true;
    } catch {
      state.fallback();
      state.diagnostic = 'connection-unavailable';
    }
    return state;
  }

  async verify(rpc: Rpc, threadId: string, state: CodexRetrievalState): Promise<boolean> {
    if (!state.ready) return false;
    try {
      while (Date.now() < state.deadline) {
        const result = (await beforeDeadline(
          rpc.request('mcpServerStatus/list', {
            threadId,
            serverName: serenaServerName,
            detail: 'full',
          }),
          state.deadline,
        )) as {
          data?: Array<{
            name?: string;
            runtimeStatus?: string;
            toolsError?: string;
            tools?: Record<string, unknown>;
          }>;
        };
        const server = result.data?.find((entry) => entry.name === serenaServerName);
        if (
          server?.runtimeStatus === 'connected' &&
          !server.toolsError &&
          serenaTools.every((tool) => Object.hasOwn(server.tools ?? {}, tool))
        )
          return true;
        if (server?.runtimeStatus !== 'starting') return false;
        await beforeDeadline(new Promise((resolve) => setTimeout(resolve, 25)), state.deadline);
      }
    } catch {
      /* Optional connection failure must not prevent a session. */
    }
    return false;
  }
}
