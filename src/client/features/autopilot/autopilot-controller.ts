/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createIdempotencyKey } from '../sessions/idempotency-key.js';
import {
  isAutopilotSnapshot,
  isOrgPlanAttention,
  isOrgPlanAttentionEnvelope,
  toOrgPlanAttention,
  type AutopilotSnapshot,
  type OrgPlanAttention,
} from './contracts.js';

type Event = { sequence: number; type: string; payload: unknown; occurredAt?: string };
export type AuthoritativeSession = {
  autopilot?: unknown;
  pendingInteractions?: unknown;
  currentSequence?: unknown;
};
type Relay = {
  getSession(id: string): Promise<AuthoritativeSession>;
  setAutopilot(id: string, enabled: boolean, key?: string): Promise<{ autopilot: unknown }>;
  resolveAttention(
    id: string,
    requestId: string,
    input: { operationKey: string; action: 'resume' | 'disableAutopilot'; guidance?: string },
  ): Promise<unknown>;
};

const toggleErrorMessage = (error: unknown): string => {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'AUTOPILOT_PLAN_REQUIRED')
    return 'An incomplete supervised plan is required before Autopilot can start.';
  if (code === 'AUTOPILOT_PLAN_COMPLETE')
    return 'This plan is complete, so Autopilot is unavailable.';
  if (code === 'AUTOPILOT_SESSION_UNAVAILABLE') return 'This session is unavailable for Autopilot.';
  return error instanceof Error ? error.message : 'Could not update Autopilot.';
};

export type AutopilotClientState = Readonly<{
  snapshots: ReadonlyMap<string, AutopilotSnapshot>;
  attention: ReadonlyMap<string, OrgPlanAttention>;
  pending: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
}>;

/** A server-authoritative projection shared by selected Chat and open Session cards. */
export class AutopilotController {
  #snapshots = new Map<string, AutopilotSnapshot>();
  #attention = new Map<string, OrgPlanAttention>();
  #pending = new Set<string>();
  #errors = new Map<string, string>();
  #versions = new Map<string, number>();
  /** Increments for every accepted source, including non-autopilot journal events. */
  #revisions = new Map<string, number>();
  /** Fences unsequenced reads behind an explicit local mutation intent. */
  #requestRevisions = new Map<string, number>();
  /** Fences list and getSession snapshots sampled before a local mutation settles. */
  #mutationEpochs = new Map<string, number>();
  /**
   * A successful local mutation may be followed by a shared list/get snapshot
   * that was sampled before it began. Do not accept such a snapshot until a
   * strictly newer journal/list sequence proves it was sampled afterwards.
   */
  #successfulMutationFloors = new Map<string, number>();
  #hydrateEpochs = new Map<string, number>();
  #cursors = new Map<string, number>();
  #wanted = new Set<string>();
  #disposed = false;
  constructor(
    private readonly relay: Relay,
    private readonly publish: (state: AutopilotClientState) => void,
    private readonly createKey: () => string = createIdempotencyKey,
  ) {}

  bootstrap(sessions: readonly ({ id: string } & AuthoritativeSession)[]): void {
    if (this.#disposed) return;
    const next = new Set(sessions.map((session) => session.id));
    for (const id of this.#wanted) if (!next.has(id)) this.remove(id);
    this.#wanted = next;
    for (const session of sessions) {
      if (!this.#versions.has(session.id)) this.#versions.set(session.id, 0);
      if (!this.#revisions.has(session.id)) this.#revisions.set(session.id, 0);
      const known = this.#cursors.get(session.id) ?? 0;
      const sequence =
        typeof session.currentSequence === 'number' && Number.isInteger(session.currentSequence)
          ? session.currentSequence
          : null;
      // An authoritative list item can advance the local journal cursor. An
      // unsequenced list value only fills an empty cache and never overwrites a
      // socket publication.
      const mutationFloor = this.#successfulMutationFloors.get(session.id);
      if (
        !this.#pending.has(session.id) &&
        (mutationFloor === undefined || (sequence !== null && sequence > mutationFloor)) &&
        ((sequence !== null && sequence > known) ||
          (!this.#snapshots.has(session.id) && known === 0))
      ) {
        if (sequence !== null) {
          this.#cursors.set(session.id, sequence);
          if (mutationFloor !== undefined && sequence > mutationFloor)
            this.#successfulMutationFloors.delete(session.id);
        }
        this.#acceptSnapshot(session.id, session);
      }
      // AgentActivityController owns the shared getSession lifecycle and will
      // forward its complete authoritative snapshot through applyAuthoritative.
    }
    this.#publish();
  }

  observe(id: string, event: Event): void {
    if (this.#disposed || !this.#wanted.has(id) || !Number.isInteger(event.sequence)) return;
    const cursor = this.#cursors.get(id) ?? 0;
    if (event.sequence <= cursor) return;
    this.#cursors.set(id, event.sequence);
    this.#revisions.set(id, (this.#revisions.get(id) ?? 0) + 1);
    // AgentActivityController owns sequence-gap reconciliation for this shared
    // journal stream. This projection must never start a second refresh.
    if (event.type === 'autopilot.updated') this.#applySnapshot(id, event.payload);
    if (event.type === 'org-plan.attention-required') this.#applyAttention(id, event.payload);
    if (event.type === 'org-plan.attention-resolved') {
      if (
        event.payload &&
        typeof event.payload === 'object' &&
        (event.payload as { outcome?: unknown }).outcome === 'failed'
      )
        this.#attention.delete(id);
      else this.#attention.delete(id);
    }
    this.#publish();
  }

  async hydrate(id: string, expectedCursor?: number): Promise<void> {
    const version = this.#versions.get(id) ?? 0;
    const epoch = (this.#hydrateEpochs.get(id) ?? 0) + 1;
    this.#hydrateEpochs.set(id, epoch);
    const requestedCursor = expectedCursor ?? this.#cursors.get(id) ?? 0;
    const requestRevision = this.#requestRevisions.get(id);
    const mutationEpoch = this.#mutationEpochs.get(id) ?? 0;
    try {
      const session = await this.relay.getSession(id);
      if (
        !this.#current(id, version) ||
        this.#hydrateEpochs.get(id) !== epoch ||
        (this.#mutationEpochs.get(id) ?? 0) !== mutationEpoch ||
        (this.#requestRevisions.has(id) && this.#requestRevisions.get(id) !== requestRevision)
      )
        return;
      const currentCursor = this.#cursors.get(id) ?? 0;
      const responseSequence =
        typeof session.currentSequence === 'number' && Number.isInteger(session.currentSequence)
          ? session.currentSequence
          : null;
      if (responseSequence !== null && responseSequence > currentCursor) {
        this.#cursors.set(id, responseSequence);
        this.#acceptSnapshot(id, session);
      } else if (responseSequence === null && currentCursor === requestedCursor) {
        this.#acceptSnapshot(id, session);
      }
      this.#publish();
    } catch {
      /* Retain the last server-confirmed state; a later replay or refresh converges it. */
    }
  }

  async toggle(id: string, enabled: boolean): Promise<void> {
    if (this.#disposed || !this.#wanted.has(id) || this.#pending.has(id)) return;
    const version = this.#versions.get(id) ?? 0;
    const revision = this.#revisions.get(id) ?? 0;
    this.#requestRevisions.set(id, (this.#requestRevisions.get(id) ?? 0) + 1);
    this.#mutationEpochs.set(id, (this.#mutationEpochs.get(id) ?? 0) + 1);
    this.#pending.add(id);
    this.#errors.delete(id);
    this.#publish();
    try {
      const result = await this.relay.setAutopilot(id, enabled, this.createKey());
      if (this.#current(id, version) && this.#revisions.get(id) === revision) {
        this.#applySnapshot(id, result.autopilot);
        this.#revisions.set(id, revision + 1);
        this.#successfulMutationFloors.set(id, this.#cursors.get(id) ?? 0);
        // The mutation response is an authoritative statement that the user
        // explicitly disabled the coordinator. Do not retain a stale alert
        // while waiting for its later journal resolution event.
        if (isAutopilotSnapshot(result.autopilot) && !result.autopilot.enabled) {
          this.#attention.delete(id);
        }
      }
    } catch (error) {
      // A newer authoritative socket update wins over both a late success and a
      // late failure from this local request.
      if (this.#current(id, version) && this.#revisions.get(id) === revision)
        this.#errors.set(id, toggleErrorMessage(error));
    } finally {
      if (this.#current(id, version)) {
        this.#pending.delete(id);
        this.#mutationEpochs.set(id, (this.#mutationEpochs.get(id) ?? 0) + 1);
      }
      this.#publish();
    }
  }

  async resolve(
    id: string,
    action: 'resume' | 'disableAutopilot',
    guidance?: string,
  ): Promise<void> {
    const item = this.#attention.get(id);
    if (!item || this.#pending.has(id) || this.#disposed) return;
    const trimmed = guidance?.trim();
    if (trimmed && trimmed.length > 600) {
      this.#errors.set(id, 'Guidance must be 600 characters or fewer.');
      this.#publish();
      return;
    }
    const version = this.#versions.get(id) ?? 0;
    const revision = this.#revisions.get(id) ?? 0;
    this.#mutationEpochs.set(id, (this.#mutationEpochs.get(id) ?? 0) + 1);
    this.#pending.add(id);
    this.#errors.delete(id);
    this.#publish();
    try {
      await this.relay.resolveAttention(id, item.requestId, {
        operationKey: this.createKey(),
        action,
        ...(trimmed ? { guidance: trimmed } : {}),
      });
      if (this.#current(id, version) && this.#revisions.get(id) === revision)
        await this.hydrate(id);
    } catch (error) {
      if (this.#current(id, version) && this.#revisions.get(id) === revision)
        this.#errors.set(
          id,
          error instanceof Error ? error.message : 'Could not resolve attention.',
        );
    } finally {
      if (this.#current(id, version)) {
        this.#pending.delete(id);
        this.#mutationEpochs.set(id, (this.#mutationEpochs.get(id) ?? 0) + 1);
      }
      this.#publish();
    }
  }

  remove(id: string): void {
    this.#versions.set(id, (this.#versions.get(id) ?? 0) + 1);
    this.#wanted.delete(id);
    this.#snapshots.delete(id);
    this.#attention.delete(id);
    this.#pending.delete(id);
    this.#errors.delete(id);
    this.#cursors.delete(id);
    this.#revisions.delete(id);
    this.#requestRevisions.delete(id);
    this.#mutationEpochs.delete(id);
    this.#successfulMutationFloors.delete(id);
    this.#hydrateEpochs.delete(id);
    this.#publish();
  }
  dispose(): void {
    this.#disposed = true;
    this.#wanted.clear();
    this.#snapshots.clear();
    this.#attention.clear();
    this.#pending.clear();
    this.#errors.clear();
    this.#hydrateEpochs.clear();
    this.#revisions.clear();
    this.#requestRevisions.clear();
    this.#mutationEpochs.clear();
    this.#successfulMutationFloors.clear();
    this.#publish();
  }
  #current(id: string, version: number): boolean {
    return !this.#disposed && this.#wanted.has(id) && this.#versions.get(id) === version;
  }
  #applySnapshot(id: string, candidate: unknown): void {
    if (!isAutopilotSnapshot(candidate)) return;
    this.#snapshots.set(id, candidate);
  }
  #applyAttention(id: string, candidate: unknown): void {
    if (isOrgPlanAttention(candidate)) {
      this.#attention.set(id, candidate);
    } else if (isOrgPlanAttentionEnvelope(candidate)) {
      this.#attention.set(id, toOrgPlanAttention(candidate));
    } else if (Array.isArray(candidate)) {
      const item = candidate.find(isOrgPlanAttentionEnvelope);
      if (item) {
        this.#attention.set(id, toOrgPlanAttention(item));
      } else this.#attention.delete(id);
    }
  }
  /** Receives the one authoritative snapshot owned by AgentActivityController. */
  applyAuthoritative(id: string, session: AuthoritativeSession): void {
    if (this.#disposed || !this.#wanted.has(id)) return;
    if (this.#pending.has(id)) return;
    const sequence =
      typeof session.currentSequence === 'number' && Number.isInteger(session.currentSequence)
        ? session.currentSequence
        : null;
    const cursor = this.#cursors.get(id) ?? 0;
    const mutationFloor = this.#successfulMutationFloors.get(id);
    if (mutationFloor !== undefined && (sequence === null || sequence <= mutationFloor)) return;
    if (sequence !== null && sequence < cursor) return;
    if (sequence !== null) {
      this.#cursors.set(id, sequence);
      if (mutationFloor !== undefined && sequence > mutationFloor)
        this.#successfulMutationFloors.delete(id);
    }
    this.#acceptSnapshot(id, session);
    this.#publish();
  }
  #acceptSnapshot(id: string, session: AuthoritativeSession): void {
    this.#revisions.set(id, (this.#revisions.get(id) ?? 0) + 1);
    this.#applySnapshot(id, session.autopilot);
    this.#applyAttention(id, session.pendingInteractions);
  }
  #publish(): void {
    this.publish({
      snapshots: new Map(this.#snapshots),
      attention: new Map(this.#attention),
      pending: new Set(this.#pending),
      errors: new Map(this.#errors),
    });
  }
}
