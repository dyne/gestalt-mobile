/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import {
  unknownReadiness,
  type RetrievalReadiness,
  type ReadinessState,
} from '../../../shared/contracts/retrieval-readiness.js';

/** Demand-driven observations only: this class never invokes a tool or scans source. */
export class ReadinessEvidence {
  private value = unknownReadiness();
  private key: string | undefined;
  private token = randomUUID();

  get generation(): string {
    return this.token;
  }
  snapshot(): RetrievalReadiness {
    return structuredClone(this.value);
  }

  /** The caller owns the source/config/tool generation; even negative results expire on change. */
  bind(key: string, repository: RetrievalReadiness['repository'] = null): string {
    if (this.key !== key) {
      if (this.key !== undefined) this.invalidate();
      this.key = key;
    }
    this.value.repository = repository
      ? {
          ...repository,
          state: 'ready',
          observedAt: new Date().toISOString(),
          generation: this.token,
        }
      : null;
    return this.token;
  }

  invalidate(): void {
    this.token = randomUUID();
    if (this.value.repository) this.value.repository = { ...this.value.repository, state: 'stale' };
    for (const kind of ['connection', 'symbols', 'references', 'coverage'] as const) {
      const prior = this.value[kind];
      this.value[kind] = {
        ...prior,
        state: prior.observedAt ? 'stale' : 'unknown',
        reason: 'invalidated',
      };
    }
  }

  connection(state: 'ready' | 'unavailable' | 'unknown'): void {
    if (state === 'unavailable' && this.value.connection.state === 'ready') this.invalidate();
    this.value.connection = { state, observedAt: new Date().toISOString(), generation: this.token };
  }

  /** Accept only a completed supported native operation, never a catalog/tool-list inference. */
  semantic(generation: string, tool: string, succeeded: boolean, sourceId?: string): boolean {
    if (generation !== this.token || this.value.connection.state !== 'ready') return false;
    const kind =
      tool === 'get_symbols_overview' || tool === 'find_symbol'
        ? 'symbols'
        : tool === 'find_referencing_symbols'
          ? 'references'
          : undefined;
    if (!kind) return false;
    this.value[kind] = {
      state: succeeded ? 'ready' : 'unavailable',
      observedAt: new Date().toISOString(),
      generation,
      scope: 'source',
      ...(sourceId ? { sourceId } : {}),
      ...(succeeded ? {} : { reason: 'operation-failed' as const }),
    };
    return true;
  }

  needsProbe(kind: 'symbols' | 'references'): boolean {
    return this.value[kind].generation !== this.token;
  }

  coverage(state: ReadinessState, counts: { files?: number; records?: number } = {}): void {
    const safe = (value: number | undefined) =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0;
    this.value.coverage = {
      state,
      observedAt: new Date().toISOString(),
      generation: this.token,
      scope: 'workspace-index',
      ...(safe(counts.files) ? { files: counts.files } : {}),
      ...(safe(counts.records) ? { records: counts.records } : {}),
      ...(state === 'unavailable' && counts.records === 0
        ? { reason: 'empty-index' as const }
        : {}),
    };
  }
}
