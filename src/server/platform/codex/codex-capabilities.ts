/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { beforeDeadline, CodexXerj, type CodexRetrievalState } from '../retrieval/codex-xerj.js';
import { CodexSerena } from './codex-serena.js';
import { RepositoryReadiness } from '../retrieval/repository-readiness.js';
import { withCapabilityInstructions } from './instruction-blocks.js';
import { prepareStartupGuidance, type StartupGuidance } from './startup-guidance.js';

type Input = Parameters<CodexXerj['prepare']>[0];
/** The two managed capabilities share lifecycle, but never share availability or approvals. */
export class CodexCapabilities {
  private readonly states = new WeakMap<
    CodexRetrievalState,
    { xerj: CodexRetrievalState; serena: CodexRetrievalState }
  >();
  constructor(
    private readonly xerj: CodexXerj,
    private readonly serena: CodexSerena,
  ) {}

  async prepare(input: Input): Promise<CodexRetrievalState> {
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
    let startup: StartupGuidance | undefined;
    const canComposeInstructions =
      native !== null || typeof input.config.developer_instructions === 'string';
    let instructions =
      typeof input.config.developer_instructions === 'string'
        ? input.config.developer_instructions
        : typeof native?.developer_instructions === 'string'
          ? native.developer_instructions
          : '';
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
    // Connection verification is a separate bounded phase for Serena. A slow
    // optional XERJ probe must not spend Serena's entire connection allowance.
    const serenaVerificationMs = Math.max(1, Math.min(5_000, input.deadline - Date.now()));
    const [xerj, serena] = await Promise.all([
      this.xerj.prepare(preparedInput),
      this.serena.prepare(preparedInput),
    ]);
    if (serena.ready) serena.deadline = Date.now() + serenaVerificationMs;
    const serenaPath = input.skills.find((skill) => skill.name === 'gestalt:serena')?.path;
    const state: CodexRetrievalState = {
      get startup() {
        return startup;
      },
      // A recognized missing rollout starts a new thread in this same owned
      // runtime. Only the bounded instruction read/composition is repeated.
      prepareFreshStartup: () => prepareFreshStartup(Date.now() + 5_000),
      repositories: new RepositoryReadiness(input.cwd),
      get backendPreparation() {
        return xerj.backendPreparation;
      },
      deadline: Math.max(
        input.deadline,
        xerj.ready ? xerj.deadline : input.deadline,
        serena.ready ? serena.deadline : input.deadline,
      ),
      get ready() {
        return xerj.ready || serena.ready;
      },
      get capabilities() {
        return [
          {
            skillName: 'gestalt:xerj',
            serverName: 'gestalt-xerj',
            ready: xerj.ready,
            diagnostic: xerj.diagnostic,
            readiness: xerj.readiness,
          },
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
        return xerj.skillsConfig.map((entry) =>
          entry.path === serenaPath
            ? (serena.skillsConfig.find((candidate) => candidate.path === serenaPath) ?? entry)
            : entry,
        );
      },
      get config() {
        let combined = instructions;
        if (xerj.instructionBlock)
          combined = withCapabilityInstructions(combined, 'xerj', xerj.instructionBlock);
        if (serena.instructionBlock)
          combined = withCapabilityInstructions(combined, 'serena', serena.instructionBlock);
        const config: Record<string, unknown> = {
          ...input.config,
          mcp_servers: {
            ...(xerj.config.mcp_servers as object),
            ...(serena.config.mcp_servers as object),
          },
          skills: {
            config: [
              ...((xerj.config.skills as { config?: unknown[] })?.config ?? []),
              ...((serena.config.skills as { config?: unknown[] })?.config ?? []),
            ],
          },
        };
        // A failed read does not establish that the native scalar is empty.
        if (canComposeInstructions) config.developer_instructions = combined;
        else delete config.developer_instructions;
        return config;
      },
      // verify already disables only the failed connection; runtime rebinds the composed config.
      fallback() {},
    };
    this.states.set(state, { xerj, serena });
    return state;
  }

  async verify(rpc: Input['rpc'], threadId: string, state: CodexRetrievalState): Promise<boolean> {
    const pair = this.states.get(state);
    if (!pair) return false;
    const [xerj, serena] = await Promise.all([
      pair.xerj.ready ? this.xerj.verify(rpc, threadId, pair.xerj) : true,
      pair.serena.ready ? this.serena.verify(rpc, threadId, pair.serena) : true,
    ]);
    if (!xerj) {
      pair.xerj.fallback();
      pair.xerj.diagnostic = 'connection-unavailable';
    }
    if (!serena) {
      pair.serena.fallback();
      pair.serena.diagnostic = 'connection-unavailable';
    }
    return xerj && serena;
  }
}
