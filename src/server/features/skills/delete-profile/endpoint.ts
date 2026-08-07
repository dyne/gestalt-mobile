/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import type { SkillProfileStore } from '../application/ports.js';
import { SkillProfileError } from '../model/errors.js';
import { normalizeSkillProfileName } from '../model/skill-profile.js';
import { problem } from '../../../platform/http/problem.js';

export type DeleteSkillProfileDependencies = Pick<SkillProfileStore, 'deleteGlobalProfile'>;

/** Registers the profile-management deletion command; it has no session dependency. */
export function registerDeleteSkillProfile(
  app: FastifyInstance,
  deps: DeleteSkillProfileDependencies,
): void {
  app.delete('/api/skill-profiles/:name', async (request, reply) => {
    try {
      const name = normalizeSkillProfileName((request.params as { name: string }).name);
      if (!(await deps.deleteGlobalProfile(name)))
        return reply
          .code(404)
          .type('application/problem+json')
          .send(problem('SKILL_PROFILE_NOT_FOUND', 404, 'The skill profile was not found.'));
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof SkillProfileError)
        return reply
          .code(400)
          .type('application/problem+json')
          .send(problem('INVALID_SKILL_PROFILE', 400, 'The skill profile could not be deleted.'));
      return reply
        .code(500)
        .type('application/problem+json')
        .send(
          problem(
            'SKILL_PROFILE_PERSISTENCE_FAILED',
            500,
            'The skill profile could not be deleted.',
            true,
          ),
        );
    }
  });
}
