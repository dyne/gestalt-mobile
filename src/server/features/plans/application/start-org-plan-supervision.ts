/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import {
  orgPlanLaunchRequestSchema,
  type OrgPlanLaunchRequest,
  type OrgPlanLaunchResult,
  type OrgPlanPreparation,
} from '../../../../shared/contracts/org-plan-execution.js';
import type {
  EffectiveSkillSelection,
  RelaySessionSnapshot,
} from '../../sessions/model/relay-session.js';
import {
  fingerprintTurnInput,
  type SubmitSessionTurn,
} from '../../sessions/start-turn/use-case.js';
import type { OrgPlanLaunchRecord, OrgPlanLaunchStore } from './org-plan-launch-store.js';

export type StartOrgPlanSupervisionDependencies = {
  prepare(
    reference: OrgPlanLaunchRequest['reference'],
    expectedRevision: string,
    skillProfile?: string,
    ownUnpublishedLaunchId?: string,
  ): Promise<OrgPlanPreparation>;
  /** Checks current permitted workspace scope without requiring unchanged source content. */
  authorizeReplay(record: OrgPlanLaunchRecord): Promise<boolean>;
  captureSkills(
    context: Extract<OrgPlanPreparation, { kind: 'eligible' }>,
  ): Promise<EffectiveSkillSelection>;
  reclaimForgottenOwner?(canonicalPath: string): void;
  createId(): string;
  launches: OrgPlanLaunchStore;
  sessions: {
    create(
      id: string,
      context: Extract<OrgPlanPreparation, { kind: 'eligible' }>,
      selection: EffectiveSkillSelection,
      publication: OrgPlanLaunchRecord,
    ): Promise<RelaySessionSnapshot>;
    find(id: string): RelaySessionSnapshot | null;
    unavailable?(id: string): boolean;
    recover?(session: RelaySessionSnapshot): Promise<RelaySessionSnapshot | null>;
  };
  submitTurn: SubmitSessionTurn;
  acceptedTurn?(record: OrgPlanLaunchRecord): RelaySessionSnapshot | null;
  onSettled?(sessionId: string): void;
};

/** One public application boundary, including durable ownership and retry rules. */
export async function startOrgPlanSupervision(
  request: OrgPlanLaunchRequest,
  deps: StartOrgPlanSupervisionDependencies,
): Promise<OrgPlanLaunchResult> {
  const parsed = orgPlanLaunchRequestSchema.safeParse(request);
  if (!parsed.success)
    return {
      kind: 'rejected',
      code: 'INVALID_LAUNCH_REQUEST',
      reason: 'Confirm a valid plan and launch identity.',
    };
  const input = parsed.data;
  const reference = input.reference;
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        reference.kind,
        reference.kind === 'workspace' ? reference.workspaceId : reference.sessionId,
        reference.kind === 'retained-session' ? null : reference.planName,
        input.expectedRevision,
        input.skillProfile ?? null,
      ]),
    )
    .digest('hex');
  let record = deps.launches.find(input.launchId);
  let preparedHere = false;
  if (record) {
    if (!(await deps.authorizeReplay(record))) return unavailable();
    if (record.requestFingerprint !== fingerprint) return conflict();
  } else {
    const context = await deps.prepare(reference, input.expectedRevision, input.skillProfile);
    if (context.kind === 'blocked') {
      // Another delivery can reserve/attach while this delivery is preparing.
      // Records are retained, so one bounded re-entry takes the replay path.
      return deps.launches.find(input.launchId) ? startOrgPlanSupervision(input, deps) : context;
    }
    let skillSelection: EffectiveSkillSelection;
    try {
      skillSelection = await deps.captureSkills(context);
    } catch {
      return {
        kind: 'blocked',
        code: 'SKILL_PROFILE_UNAVAILABLE',
        reason: 'Supervisor skills changed or could not be read. Refresh and confirm again.',
      };
    }
    if (!skillSelection.skills.some((skill) => skill.name === 'gestalt:org-plan' && skill.enabled))
      return {
        kind: 'blocked',
        code: 'GESTALT_CAPABILITIES_UNAVAILABLE',
        reason: 'The Org-plan skill changed before launch. Refresh and confirm again.',
      };
    deps.reclaimForgottenOwner?.(context.sourcePath);
    const reservation = deps.launches.reserve({
      launchId: input.launchId,
      requestFingerprint: fingerprint,
      sessionId: deps.createId(),
      canonicalPath: context.sourcePath,
      context,
      skillSelection,
      phase: 'reserved',
      bootstrapFingerprint: fingerprintTurnInput(supervisionRequest(context.sourcePath)),
    });
    record = reservation.record;
    preparedHere = reservation.kind === 'reserved';
    if (reservation.kind === 'owned')
      return {
        kind: 'blocked',
        code: 'ACTIVE_SUPERVISION',
        reason:
          'This plan already has a supervisor launch. Open its session to continue or recover it.',
        ...(deps.sessions.find(record.sessionId) ? { existingSessionId: record.sessionId } : {}),
      };
    if (record.requestFingerprint !== fingerprint) return conflict();
  }
  return deps.launches.run(input.launchId, async () => {
    const current = deps.launches.find(input.launchId)!;
    if (!(await deps.authorizeReplay(current))) return unavailable();
    if (current.requestFingerprint !== fingerprint) return conflict();
    if (
      !preparedHere &&
      !deps.sessions.find(current.sessionId) &&
      ['reserved', 'creating'].includes(current.phase)
    ) {
      const validation = await revalidateUnpublished(input, current, deps);
      if (validation) return validation;
    }
    return continueLaunch(deps.launches.find(current.launchId) ?? current, deps);
  });
}

async function continueLaunch(
  record: OrgPlanLaunchRecord,
  deps: StartOrgPlanSupervisionDependencies,
): Promise<OrgPlanLaunchResult> {
  if (deps.sessions.unavailable?.(record.sessionId)) return unavailable();
  let session = deps.sessions.find(record.sessionId);
  if (record.bootstrap) {
    return session
      ? { kind: 'started', launchId: record.launchId, session, bootstrap: record.bootstrap }
      : unavailable();
  }
  if (record.phase === 'submitting') {
    const receipt = deps.acceptedTurn?.(record);
    if (receipt?.activeTurnId && session) {
      const bootstrap = {
        kind: 'accepted' as const,
        requestId: `org-plan-bootstrap:${record.launchId}`,
        turnId: receipt.activeTurnId,
      };
      deps.launches.save({ ...record, phase: 'accepted', bootstrap }, 'submitting');
      deps.onSettled?.(session.id);
      return { kind: 'started', launchId: record.launchId, session, bootstrap };
    }
    return session
      ? partial(
          record,
          session,
          'bootstrap',
          record.manualRecoveryTurnId
            ? 'Bootstrap acceptance remains unconfirmed. You continued through ordinary Chat; Execute will not repeat the bootstrap.'
            : 'Bootstrap acceptance is uncertain. Inspect history and send explicit recovery guidance in ordinary Chat; Execute will not repeat the bootstrap.',
        )
      : pending(record, deps, 'bootstrap');
  }
  if (record.phase === 'reserved' && session) {
    deps.launches.save({ ...record, phase: 'session' }, 'reserved');
    record = deps.launches.find(record.launchId)!;
  }
  if ((record.phase === 'reserved' || record.phase === 'creating') && !session) {
    if (record.notPersisted && !deps.launches.acquireOwner(record)) {
      const owner = deps.launches.owner(record.canonicalPath);
      return {
        kind: 'blocked',
        code: 'ACTIVE_SUPERVISION',
        reason: 'Another launch now owns this plan.',
        ...(owner && deps.sessions.find(owner.sessionId)
          ? { existingSessionId: owner.sessionId }
          : {}),
      };
    }
    if (
      record.phase === 'reserved' &&
      !deps.launches.save({ ...record, phase: 'creating' }, 'reserved')
    )
      return pending(record, deps, 'activation');
    record = { ...record, phase: 'creating' };
    try {
      session = await deps.sessions.create(
        record.sessionId,
        record.context,
        record.skillSelection,
        record,
      );
    } catch (error) {
      session = deps.sessions.find(record.sessionId);
      if (session) deps.launches.save({ ...record, phase: 'session' }, 'creating');
      else if (error instanceof OrgPlanSessionNotPublished) {
        deps.launches.revokePublication(record, deps.sessions);
      }
      return session
        ? partial(
            record,
            session,
            'activation',
            'The session was saved but could not start. Open it to recover.',
          )
        : {
            kind: 'blocked',
            code: 'CODEX_UNAVAILABLE',
            reason: 'The supervisor session could not be saved. Retry after refreshing.',
          };
    }
    deps.launches.save({ ...record, phase: 'session' }, 'creating');
    record = deps.launches.find(record.launchId) ?? { ...record, phase: 'session' };
  }
  if (record.bootstrap && session)
    return {
      kind: 'started',
      launchId: record.launchId,
      session: deps.sessions.find(session.id) ?? session,
      bootstrap: record.bootstrap,
    };
  if (!session) return pending(record, deps, 'activation');
  if (
    session.desiredState === 'active' &&
    ['starting', 'recovering', 'ready'].includes(session.state) &&
    deps.sessions.recover &&
    (record.phase === 'creating' || session.state !== 'ready')
  ) {
    try {
      const recovered = await deps.sessions.recover(session);
      if (recovered) {
        session = recovered;
        deps.launches.save({ ...record, phase: 'session' }, record.phase);
        record = { ...record, phase: 'session' };
      }
    } catch {
      return partial(
        record,
        deps.sessions.find(session.id) ?? session,
        'activation',
        'This session could not acquire its ordinary writer. Open it to recover without starting another session.',
      );
    }
  }
  if (deps.sessions.unavailable?.(record.sessionId)) return unavailable();
  session = deps.sessions.find(record.sessionId);
  if (!session) return pending(record, deps, 'activation');
  if (record.phase === 'creating' || session.state !== 'ready' || session.desiredState !== 'active')
    return partial(
      record,
      session,
      'activation',
      'This existing session is not ready. Use its ordinary session controls to recover.',
    );
  if (!deps.launches.save({ ...record, phase: 'submitting' }, 'session'))
    return pending(record, deps, 'bootstrap');
  const requestId = `org-plan-bootstrap:${record.launchId}`;
  try {
    const turn = await deps.submitTurn({
      sessionId: session.id,
      text: supervisionRequest(record.canonicalPath),
      key: requestId,
    });
    if (turn.kind === 'accepted' && turn.session.activeTurnId) {
      const bootstrap = { kind: 'accepted' as const, requestId, turnId: turn.session.activeTurnId };
      deps.launches.save({ ...record, phase: 'accepted', bootstrap }, 'submitting');
      deps.onSettled?.(session.id);
      const currentSession = deps.sessions.find(session.id);
      if (!currentSession || deps.sessions.unavailable?.(session.id)) return unavailable();
      return {
        kind: 'started',
        launchId: record.launchId,
        session: currentSession,
        bootstrap,
      };
    }
    // A definitive ordinary rejection has not accepted a turn and can be retried safely.
    deps.launches.save({ ...record, phase: 'session' }, 'submitting');
  } catch {
    // Retain the durable submitting fence: transport failure may hide accepted work.
  }
  return partial(
    record,
    deps.sessions.find(session.id) ?? session,
    'bootstrap',
    'The session is available, but its supervision request was not confirmed. Open it to recover.',
  );
}

/** Only a completed ordinary create call with proof it never entered publication may use this. */
export class OrgPlanSessionNotPublished extends Error {
  constructor() {
    super('ORG_PLAN_SESSION_NOT_PUBLISHED');
  }
}

async function revalidateUnpublished(
  input: OrgPlanLaunchRequest,
  record: OrgPlanLaunchRecord,
  deps: StartOrgPlanSupervisionDependencies,
): Promise<OrgPlanLaunchResult | null> {
  const fresh = await deps.prepare(
    input.reference,
    input.expectedRevision,
    input.skillProfile,
    record.launchId,
  );
  let blocked: OrgPlanLaunchResult | null = fresh.kind === 'blocked' ? fresh : null;
  if (fresh.kind === 'eligible') {
    try {
      const skills = await deps.captureSkills(fresh);
      if (
        fresh.sourcePath !== record.canonicalPath ||
        fresh.revision !== record.context.revision ||
        fresh.workspace.id !== record.context.workspace.id ||
        fresh.workspace.path !== record.context.workspace.path ||
        stableJSON(fresh.settings) !== stableJSON(record.context.settings) ||
        stableJSON(skills) !== stableJSON(record.skillSelection)
      )
        blocked = {
          kind: 'blocked',
          code: 'CONTEXT_CHANGED',
          reason:
            'The never-published launch context or defaults changed. Refresh and confirm a new launch intent.',
        };
    } catch {
      blocked = {
        kind: 'blocked',
        code: 'SKILL_PROFILE_UNAVAILABLE',
        reason: 'Supervisor skills changed. Refresh and confirm again.',
      };
    }
  }
  if (blocked) {
    // Revocation fences any delayed publisher; absence alone is never death proof.
    if (
      !deps.launches.revokePublication(record, deps.sessions) &&
      deps.sessions.find(record.sessionId)
    )
      return null;
    return blocked;
  }
  return null;
}
function stableJSON(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sorted(entry)]),
          )
        : item;
  return JSON.stringify(sorted(value));
}

function partial(
  record: OrgPlanLaunchRecord,
  session: RelaySessionSnapshot,
  stage: 'activation' | 'bootstrap',
  reason: string,
): OrgPlanLaunchResult {
  return {
    kind: 'partial',
    launchId: record.launchId,
    session,
    bootstrap: { kind: 'pending' },
    stage,
    reason,
  };
}
function pending(
  record: OrgPlanLaunchRecord,
  deps: StartOrgPlanSupervisionDependencies,
  stage: 'activation' | 'bootstrap',
): OrgPlanLaunchResult {
  const session = deps.sessions.find(record.sessionId);
  return session
    ? partial(
        record,
        session,
        stage,
        'The existing launch is still being resolved. Open its session to recover.',
      )
    : {
        kind: 'blocked',
        code: 'CODEX_UNAVAILABLE',
        reason:
          'The launch is reserved but session publication is not confirmed. Retry the same launch identity.',
      };
}
function unavailable(): OrgPlanLaunchResult {
  return {
    kind: 'blocked',
    code: 'REFERENCE_UNAVAILABLE',
    reason:
      'The original session or permitted workspace is no longer available. Refresh before starting another launch.',
  };
}
function conflict(): OrgPlanLaunchResult {
  return {
    kind: 'rejected',
    code: 'LAUNCH_CONFLICT',
    reason: 'This launch identity was already used with different confirmed inputs.',
  };
}

function supervisionRequest(canonicalPath: string): string {
  return [
    'Use $gestalt:org-plan to load and supervise this exact Org plan:',
    JSON.stringify(canonicalPath),
    'Follow the complete supervised execution workflow: single writer per milestone, required skill loading, focused tests, independent review and acceptance, one conventional commit per accepted milestone, checkpoints, and terminal whole-branch review.',
    'Preserve the plan progress and model policy, Manual Off, attention, permissions, sandbox and approval gates. The normal supervisor plan-loading and real helper supervision-start publication establish attachment and continuation.',
  ].join('\n');
}
