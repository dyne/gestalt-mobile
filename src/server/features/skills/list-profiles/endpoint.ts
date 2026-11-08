/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { SkillProfileStore } from '../application/ports.js';
import { problem } from '../../../platform/http/problem.js';
import { readGlobalSkillProfiles } from '../application/read-global-profiles.js';

export type ListSkillProfilesDependencies = Pick<
  SkillProfileStore,
  'listGlobalProfileNames' | 'readGlobalProfile'
> & {
  profilePath(name: string): string;
};

export function registerListSkillProfiles(
  app: FastifyInstance,
  deps: ListSkillProfilesDependencies,
): void {
  app.get('/api/skill-profiles', async (_request, reply) => {
    try {
      const profiles = (await readGlobalSkillProfiles(deps)).map((entry) =>
        'profile' in entry
          ? {
              name: entry.profile.name,
              version: entry.profile.version,
              path: deps.profilePath(entry.name),
              skills: entry.profile.skills,
              ...(entry.profile.capabilities ? { capabilities: entry.profile.capabilities } : {}),
            }
          : { name: entry.name, path: deps.profilePath(entry.name), error: entry.error },
      );
      return { profiles };
    } catch {
      return reply
        .code(500)
        .type('application/problem+json')
        .send(
          problem(
            'SKILL_PROFILE_PERSISTENCE_FAILED',
            500,
            'Skill profiles could not be read.',
            true,
          ),
        );
    }
  });
}
