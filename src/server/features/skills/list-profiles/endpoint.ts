/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { SkillProfileStore } from '../application/ports.js';
import { problem } from '../../../platform/http/problem.js';

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
      const names = await deps.listGlobalProfileNames();
      const profiles = await Promise.all(
        names
          .sort((a, b) => a.localeCompare(b))
          .map(async (name) => {
            try {
              const profile = await deps.readGlobalProfile(name);
              return profile
                ? {
                    name: profile.name,
                    version: profile.version,
                    path: deps.profilePath(name),
                    skills: profile.skills,
                  }
                : {
                    name,
                    path: deps.profilePath(name),
                    error: {
                      code: 'INVALID_SKILL_PROFILE',
                      message: 'Profile disappeared while reading.',
                    },
                  };
            } catch (error) {
              return {
                name,
                path: deps.profilePath(name),
                error: {
                  code: 'INVALID_SKILL_PROFILE',
                  message: error instanceof Error ? error.message : 'Invalid profile.',
                },
              };
            }
          }),
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
