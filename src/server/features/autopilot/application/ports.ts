/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AutopilotSession } from '../domain/autopilot-session.js';

export type AutopilotControlStatus = 'scheduled' | 'issued' | 'started' | 'failed' | 'cancelled';

export type AutopilotAuditEvent = Readonly<{
  sessionId: string;
  type: string;
  payload: unknown;
  occurredAt: string;
}>;

export type AutopilotOutboxEvent = AutopilotAuditEvent & Readonly<{ id: number }>;

/** A durable, opaque control command.  It deliberately has no prompt or output field. */
export type AutopilotControl = Readonly<{
  sessionId: string;
  controlId: string;
  status: AutopilotControlStatus;
  createdAt: string;
  updatedAt: string;
  failureCode: 'START_FAILED' | 'START_UNAVAILABLE' | null;
  /** Set only after the app-server has accepted this synthetic start. */
  turnId?: string | null;
}>;

/** The sole outbound capability allowed to begin an automatic turn. */
export interface AutopilotTurnStarter {
  /** Generation fences a start that races a manual send, disable, or lifecycle cancellation. */
  start(sessionId: string, controlId: string, generation: number): Promise<void>;
}

export interface AutopilotStore {
  find(sessionId: string): AutopilotSession | null;
  save(state: AutopilotSession): void;
  remove(sessionId: string): void;
  findControl(sessionId: string, controlId: string): AutopilotControl | null;
  /** Persist an autopilot state/control transition and its audit intent atomically. */
  commit?(
    input: Readonly<{
      state?: AutopilotSession;
      control?: AutopilotControl;
      events: readonly AutopilotAuditEvent[];
    }>,
  ): void;
  /** Test-double compatibility only; production coordinators require commit(). */
  saveControl?(control: AutopilotControl): void;
  /** Atomically moves a scheduled command to issued; only the winning relay may start it. */
  claimControlIssued?(
    sessionId: string,
    controlId: string,
    updatedAt: string,
    state: AutopilotSession,
    events: readonly AutopilotAuditEvent[],
  ): AutopilotControl | null;
  /** Durable events are removed only after the session journal has accepted them. */
  drainOutbox?(sessionId: string): readonly AutopilotOutboxEvent[];
  acknowledgeOutbox?(id: number): void;
  /** A control ID alone is not provenance: clients choose their own idempotency keys. */
  acceptedControlTurns?(sessionId: string): ReadonlyMap<string, string>;
  /** Counts non-cancelled automatic starts in a bounded ISO-8601 time window. */
  automaticActionsSince?(sessionId: string, since: string): number;
  /** Legacy diagnostic surface; never use for history provenance. */
  controlIds(sessionId: string): ReadonlySet<string>;
}
