/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { registerDeleteSkillProfile } from './delete-profile/endpoint.js';
import { registerListAvailableSkills } from './list-available/endpoint.js';
import { registerListSkillProfiles } from './list-profiles/endpoint.js';
import { registerReplaceSkillProfile } from './replace-profile/endpoint.js';

export function registerSkillRoutes(
  app: FastifyInstance,
  deps: Pick<AppDependencies, 'skills'>,
): void {
  if (!deps.skills) return;
  registerListAvailableSkills(app, deps.skills);
  registerListSkillProfiles(app, deps.skills);
  registerReplaceSkillProfile(app, deps.skills);
  registerDeleteSkillProfile(app, deps.skills);
}
