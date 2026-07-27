/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type SkillProfileErrorCode =
  | 'INVALID_SKILL_PROFILE'
  | 'INVALID_SKILL_PROFILE_YAML'
  | 'INVALID_SKILL_DISCOVERY'
  | 'UNKNOWN_SKILL_PROFILE';

/** A stable, transport-independent failure in the skill selection bounded context. */
export class SkillProfileError extends Error {
  constructor(public readonly code: SkillProfileErrorCode, message: string = code) {
    super(message);
    this.name = 'SkillProfileError';
  }
}
