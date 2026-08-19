/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { OrgPlanAttention } from '../../../../shared/contracts/org-plan-attention.js';

export type ActiveOrgPlanAttention = Readonly<{
  requestId: string;
  turnId: string | null;
  requestedAt: string | null;
  attention: OrgPlanAttention;
}>;

/** Outbound read port; future policy and activity slices never reach into SQLite. */
export interface OrgPlanAttentionReader {
  active(sessionId: string): ActiveOrgPlanAttention | null;
}
export type OrgPlanAttentionTransition = Readonly<{
  kind: 'required' | 'resolved' | 'failed';
  requestId: string;
  occurredAt: string;
}>;
/** Transition stream port; consumers receive feature DTOs, never journal rows. */
export interface OrgPlanAttentionTransitions {
  subscribe(
    sessionId: string,
    listener: (transition: OrgPlanAttentionTransition) => void,
  ): () => void;
}

/** Inbound resolution is deliberately the existing typed interaction reply contract. */
export interface OrgPlanAttentionResolver {
  resolve(input: {
    sessionId: string;
    requestId: string;
    operationKey: string;
    response: unknown;
  }): Promise<
    | { kind: 'accepted'; resolvedAt: string }
    | { kind: 'replayed'; resolvedAt: string }
    | {
        kind:
          | 'noActive'
          | 'staleOperation'
          | 'writerUnavailable'
          | 'writerCleared'
          | 'legacyUnsupported';
        resolvedAt?: string;
      }
  >;
}
