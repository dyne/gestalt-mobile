/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionDefaults } from './session-defaults.js';

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
        | 'ACTIVE_SUPERVISION';
      reason: string;
      existingSessionId?: string;
    }>;
