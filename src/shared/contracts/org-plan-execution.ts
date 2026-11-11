/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionDefaults } from './session-defaults.js';
import { z } from 'zod';

export type OrgPlanLaunchSettings = Omit<SessionDefaults, 'workspaceId' | 'provider'> & {
  provider: 'codex';
  profile: 'default';
};
export type OrgPlanSkillProfileOption = Readonly<{ name: string; error?: string }>;

/** References are resolved and authorized on the server; paths are never launch authority. */
export type OrgPlanReference = Readonly<
  | { kind: 'workspace'; workspaceId: string; planName: string }
  | { kind: 'session'; sessionId: string; planName: string }
  | { kind: 'retained-session'; sessionId: string }
>;

export type OrgPlanWorkspace = Readonly<{ id: string; name: string; path: string }>;

const identity = z.string().min(1).max(1024);
export const orgPlanLaunchRequestSchema = z
  .object({
    reference: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('workspace'), workspaceId: identity, planName: identity })
        .strict(),
      z.object({ kind: z.literal('session'), sessionId: identity, planName: identity }).strict(),
      z.object({ kind: z.literal('retained-session'), sessionId: identity }).strict(),
    ]),
    expectedRevision: identity,
    skillProfile: z.string().max(256).optional(),
    launchId: z.string().min(1).max(256),
  })
  .strict();

export type OrgPlanLaunchRequest = z.infer<typeof orgPlanLaunchRequestSchema>;
/** Only these feature outcomes are returned as typed non-success HTTP receipts. */
export const orgPlanLaunchConflictSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('blocked'),
      code: z.enum(['CONTEXT_CHANGED', 'ACTIVE_SUPERVISION', 'WORKSPACE_BUSY']),
      reason: z.string().min(1),
      existingSessionId: identity.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('rejected'),
      code: z.literal('LAUNCH_CONFLICT'),
      reason: z.string().min(1),
    })
    .strict(),
]);
export const orgPlanLaunchInvalidRequestSchema = z
  .object({
    kind: z.literal('rejected'),
    code: z.literal('INVALID_LAUNCH_REQUEST'),
    reason: z.string().min(1),
  })
  .strict();
/** A normal session's public identity; callers retrieve full history/state through ordinary APIs. */
export type OrgPlanLaunchSession = Readonly<{ id: string; state: string }>;
export type OrgPlanBootstrapReceipt = Readonly<{
  kind: 'accepted';
  requestId: string;
  turnId: string;
}>;
export type OrgPlanLaunchResult =
  | Extract<OrgPlanPreparation, { kind: 'blocked' }>
  | Readonly<{
      kind: 'rejected';
      code: 'INVALID_LAUNCH_REQUEST' | 'LAUNCH_CONFLICT';
      reason: string;
    }>
  | Readonly<{
      kind: 'started';
      launchId: string;
      session: OrgPlanLaunchSession;
      bootstrap: OrgPlanBootstrapReceipt;
    }>
  | Readonly<{
      kind: 'partial';
      launchId: string;
      session: OrgPlanLaunchSession;
      bootstrap: { kind: 'pending' } | OrgPlanBootstrapReceipt;
      stage: 'activation' | 'bootstrap';
      reason: string;
    }>;

export type OrgPlanPreparation =
  | Readonly<{
      kind: 'eligible';
      reference: OrgPlanReference;
      title: string;
      revision: string;
      sourcePath: string;
      workspace: OrgPlanWorkspace;
      settings: OrgPlanLaunchSettings;
      skillProfiles: readonly OrgPlanSkillProfileOption[];
      warnings: readonly string[];
    }>
  | Readonly<{
      kind: 'blocked';
      code:
        | 'REFERENCE_UNAVAILABLE'
        | 'PLAN_NOT_FOUND'
        | 'PLAN_UNREADABLE'
        | 'INVALID_PLAN'
        | 'NO_REMAINING_WORK'
        | 'CODEX_UNAVAILABLE'
        | 'MODEL_POLICY_UNAVAILABLE'
        | 'WORKSPACE_UNAVAILABLE'
        | 'CONTEXT_CHANGED'
        | 'SESSION_DEFAULTS_UNAVAILABLE'
        | 'MODEL_UNAVAILABLE'
        | 'SKILL_PROFILE_UNAVAILABLE'
        | 'GESTALT_CAPABILITIES_UNAVAILABLE'
        | 'ACTIVE_SUPERVISION'
        | 'WORKSPACE_BUSY';
      reason: string;
      existingSessionId?: string;
    }>;
