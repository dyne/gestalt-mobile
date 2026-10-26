/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ReadinessState = 'ready' | 'unknown' | 'stale' | 'unavailable';
export type ReadinessObservation = {
  state: ReadinessState;
  observedAt: string | null;
  generation: string | null;
  scope?: 'source' | 'workspace-index';
  sourceId?: string;
  reason?: 'not-probed' | 'operation-failed' | 'invalidated' | 'empty-index' | 'not-observed';
};

/** Public evidence contains opaque identities and labels, never source paths or tool output. */
export type RetrievalReadiness = {
  connection: ReadinessObservation;
  repository: {
    id: string;
    label: string;
    buildIds?: string[];
    state?: ReadinessState;
    observedAt?: string;
    generation?: string;
  } | null;
  symbols: ReadinessObservation;
  references: ReadinessObservation;
  coverage: ReadinessObservation & { files?: number; records?: number };
};

export type SessionRetrievalReadiness = {
  runtimeId?: string | null;
  observedAt?: string;
  connections: Array<{ serverName: string; readiness?: RetrievalReadiness }>;
  repositories: Array<{ threadId: string; readiness: RetrievalReadiness }>;
};

export function readinessLabel(state?: ReadinessState): string {
  return state === 'ready'
    ? 'Ready'
    : state === 'stale'
      ? 'Stale'
      : state === 'unavailable'
        ? 'Degraded'
        : 'Unverified';
}

export function semanticState(readiness: RetrievalReadiness): ReadinessState {
  const states = [readiness.symbols?.state, readiness.references?.state];
  return states.includes('unavailable')
    ? 'unavailable'
    : states.includes('stale')
      ? 'stale'
      : states.every((state) => state === 'ready')
        ? 'ready'
        : 'unknown';
}

export function repositoryLabel(label: string): string {
  return (
    label
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1)
      ?.replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 96) || 'Repository'
  );
}

export function unknownReadiness(): RetrievalReadiness {
  const unknown = (): ReadinessObservation => ({
    state: 'unknown',
    observedAt: null,
    generation: null,
    reason: 'not-probed',
  });
  return {
    connection: unknown(),
    repository: null,
    symbols: unknown(),
    references: unknown(),
    coverage: unknown(),
  };
}
