/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AgentActivitySnapshot } from './model.js';

/** Public roster projection: never expose process, thread, task-path, or host metrics identifiers. */
export function toAgentActivityDto(snapshot: AgentActivitySnapshot): unknown {
  return {
    sessionId: snapshot.sessionId,
    root: snapshot.root,
    subagents: snapshot.subagents.slice(0, 64).map((child) => ({
      id: child.id,
      ...(child.nickname ? { nickname: child.nickname } : {}),
      ...(child.role ? { role: child.role } : {}),
      ...(child.model ? { model: child.model } : {}),
      ...(child.canonicalTaskName ? { canonicalTaskName: child.canonicalTaskName } : {}),
      ...(child.canonicalPosition ? { canonicalPosition: child.canonicalPosition } : {}),
      ...(child.continuationGeneration
        ? { continuationGeneration: child.continuationGeneration }
        : {}),
      ...(child.outcome ? { outcome: child.outcome } : {}),
      ownedProcesses: (child.ownedProcesses ?? []).slice(0, 64).map((process) => ({
        state: process.state,
        ownership: process.ownership,
        observedAt: process.observedAt,
      })),
      state: child.state,
      reason: child.reason,
      observedAt: child.observedAt,
      lastActivityAt: child.lastActivityAt,
    })),
    aggregateSubagents: snapshot.aggregateSubagents,
    confidence: snapshot.confidence,
  };
}
