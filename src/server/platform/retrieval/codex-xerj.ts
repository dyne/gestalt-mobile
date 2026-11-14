/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';
import { sessionScratchEnvironmentKeys } from '../scratch/child-environment.js';
import { parseXerjStartupReason } from '../../../shared/contracts/xerj-startup.js';
import type { RetrievalCapabilityPort } from '../../features/skills/application/ports.js';
import { ReadinessEvidence } from './readiness-evidence.js';
import { withCapabilityInstructions } from '../codex/instruction-blocks.js';
import { beforeDeadline } from '../codex/capability-deadline.js';
import type { CodexCapabilityInput, CodexCapabilityState } from '../codex/capability-contracts.js';

export const xerjServerName = 'gestalt-xerj';
export const xerjTools = ['xerj_search', 'xerj_map', 'xerj_code_search'];
const connectionTimeoutMs = 5_000;
type Rpc = { request(method: string, params: unknown): Promise<unknown> };

/** Ephemeral native thread configuration; no installation or daemon ownership. */
export class CodexXerj {
  constructor(private readonly capability: RetrievalCapabilityPort) {}

  async prepare(input: CodexCapabilityInput): Promise<CodexCapabilityState> {
    const skill = input.skills.find((entry) => entry.name === 'gestalt:xerj');
    const evidence = new ReadinessEvidence();
    const state: CodexCapabilityState = {
      evidence,
      get readiness() {
        return evidence.snapshot();
      },
      ready: false,
      deadline: input.deadline,
      config: { ...input.config },
      skillsConfig: input.skillsConfig.map((entry) => ({
        ...entry,
        enabled: entry.path === skill?.path ? false : entry.enabled,
      })),
      fallback: () => {},
    };
    let native: Record<string, unknown> = {};
    let compatible = false;
    try {
      const read =
        input.nativeConfig !== undefined
          ? { config: input.nativeConfig ?? undefined }
          : ((await beforeDeadline(
              input.rpc.request('config/read', { cwd: input.cwd, includeLayers: false }),
              input.deadline,
            )) as { config?: Record<string, unknown> });
      native = read.config ?? {};
      compatible = read.config !== undefined;
    } catch {
      /* An incompatible runtime cannot safely advertise retrieval. */
    }
    const servers =
      native.mcp_servers && typeof native.mcp_servers === 'object'
        ? (native.mcp_servers as Record<string, { command?: string; args?: string[] }>)
        : {};
    const mcp: Record<string, unknown> = {};
    // Disable aliases of the managed connection without disturbing unrelated MCP.
    for (const [name, server] of Object.entries(servers)) {
      if (server?.args?.[0] === 'xerj' && server.args[1] === 'mcp')
        mcp[name] = { ...server, enabled: false, required: false };
    }
    const instructions =
      typeof input.config.developer_instructions === 'string'
        ? input.config.developer_instructions
        : typeof native.developer_instructions === 'string'
          ? native.developer_instructions
          : '';
    state.fallback = () => {
      evidence.connection('unavailable');
      state.ready = false;
      state.skillsConfig = state.skillsConfig.map((entry) => ({
        ...entry,
        enabled: entry.path === skill?.path ? false : entry.enabled,
      }));
      state.instructionBlock =
        '<gestalt_xerj_unavailable>\nXerj retrieval is unavailable in this runtime. Earlier retrieval guidance is inactive; use rg and current source reads.\n</gestalt_xerj_unavailable>';
      state.config = {
        ...input.config,
        skills: { config: [{ name: 'gestalt:xerj', enabled: false }] },
        mcp_servers: {
          ...mcp,
          [xerjServerName]: {
            command: 'gestalt',
            args: ['xerj', 'mcp'],
            enabled: false,
            required: false,
          },
        },
        developer_instructions: withCapabilityInstructions(
          instructions,
          'xerj',
          state.instructionBlock,
        ),
      };
    };
    state.fallback();
    if (!compatible || !skill || Date.now() >= input.deadline) return state;
    try {
      const ready = await this.capability.check({
        cwd: input.cwd,
        deadline: input.deadline,
        start: input.start,
      });
      if (ready.status !== 'ready') {
        if (ready.status === 'starting') state.backendPreparation = { status: 'starting' };
        if (ready.status === 'unavailable') {
          state.diagnostic = 'backend-unavailable';
          state.backendPreparation = {
            status: 'unavailable',
            reason: parseXerjStartupReason(ready.reason),
          };
        }
        return state;
      }
      const guidance = await beforeDeadline(readFile(skill.path, 'utf8'), input.deadline);
      if (guidance.length > 16_384) return state;
      // Backend preparation must not leave the native MCP handshake with only
      // a few milliseconds. These are separate, individually bounded phases.
      state.deadline = Date.now() + connectionTimeoutMs;
      state.verificationTimeoutMs = connectionTimeoutMs;
      state.skillsConfig = state.skillsConfig.map((entry) => ({
        ...entry,
        enabled: entry.path === skill.path ? true : entry.enabled,
      }));
      state.instructionBlock = `<gestalt_xerj_capability>\nWorkspace index counts do not establish coverage or freshness for a selected repository. Verify hit identity and current source before relying on it.\n${guidance}\n</gestalt_xerj_capability>`;
      state.config = {
        ...input.config,
        skills: { config: [{ name: 'gestalt:xerj', enabled: true }] },
        mcp_servers: {
          ...mcp,
          [xerjServerName]: {
            command: ready.manager,
            args: ['xerj', 'mcp', '--url', ready.endpoint],
            cwd: input.cwd,
            env_vars: [
              'CODEX_HOME',
              'GESTALT_HOME',
              'XERJ_API_KEY',
              'XERJ_AUTH',
              ...sessionScratchEnvironmentKeys,
            ],
            enabled: true,
            required: false,
            startup_readiness: 'connection',
            startup_timeout_ms: connectionTimeoutMs,
            enabled_tools: xerjTools,
            default_tools_approval_mode: 'approve',
          },
        },
        developer_instructions: withCapabilityInstructions(
          instructions,
          'xerj',
          state.instructionBlock,
        ),
      };
      state.ready = true;
      evidence.connection('unknown');
    } catch {
      state.fallback();
      state.diagnostic = 'connection-unavailable';
    }
    return state;
  }

  async verify(rpc: Rpc, threadId: string, state: CodexCapabilityState): Promise<boolean> {
    if (!state.ready) return false;
    // thread/start can consume the handshake allowance before this method runs.
    const deadline = state.verificationTimeoutMs
      ? Date.now() + state.verificationTimeoutMs
      : state.deadline;
    try {
      while (Date.now() < deadline) {
        const result = (await beforeDeadline(
          rpc.request('mcpServerStatus/list', {
            threadId,
            serverName: xerjServerName,
            detail: 'full',
          }),
          deadline,
        )) as {
          data?: Array<{
            name?: string;
            runtimeStatus?: string;
            toolsError?: string;
            tools?: Record<string, unknown>;
          }>;
        };
        const server = result.data?.find((entry) => entry.name === xerjServerName);
        if (
          server?.runtimeStatus === 'connected' &&
          !server.toolsError &&
          xerjTools.every((tool) => Object.hasOwn(server.tools ?? {}, tool))
        ) {
          state.evidence?.connection('ready');
          return true;
        }
        if (server?.runtimeStatus !== 'starting') {
          state.evidence?.connection('unavailable');
          return false;
        }
        await beforeDeadline(new Promise((resolve) => setTimeout(resolve, 25)), deadline);
      }
      state.evidence?.connection('unavailable');
      return false;
    } catch {
      state.evidence?.connection('unavailable');
      return false;
    }
  }
}
