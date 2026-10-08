/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { CodexXerj, type CodexRetrievalState } from '../retrieval/codex-xerj.js';
import { CodexSerena } from './codex-serena.js';

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
    // Connection verification is a separate bounded phase for Serena. A slow
    // optional XERJ probe must not spend Serena's entire connection allowance.
    const serenaVerificationMs = Math.max(1, Math.min(5_000, input.deadline - Date.now()));
    const [xerj, serena] = await Promise.all([
      this.xerj.prepare(input),
      this.serena.prepare(input),
    ]);
    if (serena.ready) serena.deadline = Date.now() + serenaVerificationMs;
    const serenaPath = input.skills.find((skill) => skill.name === 'gestalt:serena')?.path;
    const state: CodexRetrievalState = {
      deadline: Math.max(input.deadline, serena.ready ? serena.deadline : input.deadline),
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
          },
          {
            skillName: 'gestalt:serena',
            serverName: 'gestalt-serena',
            ready: serena.ready,
            diagnostic: serena.diagnostic,
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
        const xerjInstructions = String(xerj.config.developer_instructions ?? '');
        const serenaInstructions = String(serena.config.developer_instructions ?? '');
        return {
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
          developer_instructions: `${xerjInstructions}\n${serenaInstructions.slice(serenaInstructions.indexOf('<gestalt_serena_'))}`,
        };
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
