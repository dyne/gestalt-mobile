/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  OrgPlanBootstrapReceipt,
  OrgPlanPreparation,
} from '../../../../shared/contracts/org-plan-execution.js';
import type {
  EffectiveSkillSelection,
  RelaySessionSnapshot,
} from '../../sessions/model/relay-session.js';

export type OrgPlanLaunchPhase = 'reserved' | 'creating' | 'session' | 'submitting' | 'accepted';
export type OrgPlanLaunchRecord = {
  launchId: string;
  requestFingerprint: string;
  sessionId: string;
  canonicalPath: string;
  context: Extract<OrgPlanPreparation, { kind: 'eligible' }>;
  skillSelection: EffectiveSkillSelection;
  phase: OrgPlanLaunchPhase;
  bootstrap?: OrgPlanBootstrapReceipt;
  bootstrapFingerprint?: string;
  /** Completed create call proved it never entered durable session publication. */
  notPersisted?: boolean;
  /** An explicitly accepted ordinary Chat turn superseded unresolved startup. */
  manualRecoveryTurnId?: string;
  /** Fences a revoked publisher without assuming anything about its process lifetime. */
  publicationRevision?: number;
};

export type OrgPlanPublicationSessions = {
  find(id: string): RelaySessionSnapshot | null;
  save(session: RelaySessionSnapshot): void;
};

export type OrgPlanInitialActivation = Readonly<{ sessionId: string; revision: number }>;

/** Feature-owned durable reservation; independent of plan attachment and Autopilot. */
export interface OrgPlanLaunchStore {
  find(launchId: string): OrgPlanLaunchRecord | null;
  forSession(sessionId: string): OrgPlanLaunchRecord | null;
  owner(canonicalPath: string): OrgPlanLaunchRecord | null;
  workspaceOwner(workspacePath: string): OrgPlanLaunchRecord | null;
  reserve(record: OrgPlanLaunchRecord): {
    kind: 'reserved' | 'existing' | 'owned';
    record: OrgPlanLaunchRecord;
  };
  save(record: OrgPlanLaunchRecord, expected: OrgPlanLaunchPhase): boolean;
  releaseOwner(record: OrgPlanLaunchRecord): void;
  acquireOwner(record: OrgPlanLaunchRecord): boolean;
  publishSession(
    record: OrgPlanLaunchRecord,
    candidate: RelaySessionSnapshot,
    sessions: OrgPlanPublicationSessions,
  ): { created: boolean; session: RelaySessionSnapshot };
  revokePublication(
    record: OrgPlanLaunchRecord,
    sessions: Pick<OrgPlanPublicationSessions, 'find'>,
  ): boolean;
  run<T>(launchId: string, operation: () => Promise<T>): Promise<T>;
}
