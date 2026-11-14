/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { beforeDeadline } from './capability-deadline.js';
import type {
  CodexCapabilityInput as Input,
  CodexCapabilityState,
} from './capability-contracts.js';
import { CodexSerena } from './codex-serena.js';
import { RepositoryReadiness } from '../retrieval/repository-readiness.js';
import { withCapabilityInstructions } from './instruction-blocks.js';
import { prepareStartupGuidance, type StartupGuidance } from './startup-guidance.js';
import {
  assertNoLegacyManagedConnection,
  retireLegacyCapabilityInstructions,
} from './retired-capability-migration.js';

/** Compose retained capability guidance after the stable startup instructions. */
export class CodexCapabilities {
  private readonly states = new WeakMap<CodexCapabilityState, CodexCapabilityState>();
  constructor(private readonly serena: CodexSerena) {}

  async prepare(input: Input): Promise<CodexCapabilityState> {
    let native: Record<string, unknown> | null = null;
    try {
      const read = (await beforeDeadline(
        input.rpc.request('config/read', {
          cwd: input.cwd,
          includeLayers: false,
        }),
        input.deadline,
      )) as { config?: Record<string, unknown> };
      native = read.config ?? null;
    } catch {
      /* Native fallback remains available without optional guidance. */
    }
    await assertNoLegacyManagedConnection(native?.mcp_servers);
    await assertNoLegacyManagedConnection(input.config.mcp_servers);
    let startup: StartupGuidance | undefined;
    const canComposeInstructions =
      native !== null || typeof input.config.developer_instructions === 'string';
    let instructions = retireLegacyCapabilityInstructions(
      typeof input.config.developer_instructions === 'string'
        ? input.config.developer_instructions
        : typeof native?.developer_instructions === 'string'
          ? native.developer_instructions
          : '',
    );
    const prepareFreshStartup = async (deadline: number) => {
      if (!native) {
        startup = { status: 'unavailable', reason: 'native-config-unavailable' };
        return;
      }
      const prepared = await beforeDeadline(
        prepareStartupGuidance({
          instructions,
          native,
          skills: input.skills,
          skillsConfig: input.skillsConfig,
        }),
        deadline,
      ).catch(() => ({
        instructions,
        startup: { status: 'unavailable' as const, reason: 'invalid-contract' as const },
      }));
      instructions = prepared.instructions;
      startup = prepared.startup;
    };
    if (input.startup) await prepareFreshStartup(input.deadline);
    const preparedInput = {
      ...input,
      nativeConfig: native,
      config: { ...input.config, developer_instructions: instructions },
    };
    // Connection verification receives its own bounded allowance after preparation.
    const serenaVerificationMs = Math.max(1, Math.min(5_000, input.deadline - Date.now()));
    const serena = await this.serena.prepare(preparedInput);
    if (serena.ready) serena.deadline = Date.now() + serenaVerificationMs;
    const state: CodexCapabilityState = {
      get startup() {
        return startup;
      },
      // A recognized missing rollout starts a new thread in this same owned
      // runtime. Only the bounded instruction read/composition is repeated.
      prepareFreshStartup: () => prepareFreshStartup(Date.now() + 5_000),
      repositories: new RepositoryReadiness(input.cwd),
      deadline: Math.max(input.deadline, serena.ready ? serena.deadline : input.deadline),
      get ready() {
        return serena.ready;
      },
      get capabilities() {
        return [
          {
            skillName: 'gestalt:serena',
            serverName: 'gestalt-serena',
            ready: serena.ready,
            diagnostic: serena.diagnostic,
            readiness: serena.readiness,
          },
        ];
      },
      get skillsConfig() {
        return serena.skillsConfig;
      },
      get config() {
        let combined = instructions;
        if (serena.instructionBlock)
          combined = withCapabilityInstructions(combined, 'serena', serena.instructionBlock);
        const config: Record<string, unknown> = {
          ...input.config,
          mcp_servers: serena.config.mcp_servers,
          skills: serena.config.skills,
        };
        // A failed read does not establish that the native scalar is empty.
        if (canComposeInstructions) config.developer_instructions = combined;
        else delete config.developer_instructions;
        return config;
      },
      // verify already disables only the failed connection; runtime rebinds the composed config.
      fallback() {},
    };
    this.states.set(state, serena);
    return state;
  }

  async verify(rpc: Input['rpc'], threadId: string, state: CodexCapabilityState): Promise<boolean> {
    const prepared = this.states.get(state);
    if (!prepared) return false;
    const verified = prepared.ready ? await this.serena.verify(rpc, threadId, prepared) : true;
    if (!verified) {
      prepared.fallback();
      prepared.diagnostic = 'connection-unavailable';
    }
    return verified;
  }
}
