/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SkillProfileStore } from '../application/ports.js';
import { createSkillProfile, normalizeSkillProfileName } from '../model/skill-profile.js';
import { SkillProfileError } from '../model/errors.js';
import { problem } from '../../../platform/http/problem.js';

const requestSchema = z
  .object({
    version: z.literal(1),
    name: z.string(),
    skills: z.array(
      z.object({ name: z.string(), path: z.string(), enabled: z.boolean() }).strict(),
    ),
  })
  .strict();
export type ReplaceSkillProfileDependencies = Pick<
  SkillProfileStore,
  'readGlobalProfile' | 'replaceGlobalProfile'
> & { profilePath(name: string): string };

export function registerReplaceSkillProfile(
  app: FastifyInstance,
  deps: ReplaceSkillProfileDependencies,
): void {
  app.put('/api/skill-profiles/:name', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const body = requestSchema.safeParse(request.body);
    try {
      const name = normalizeSkillProfileName((request.params as { name: string }).name);
      if (!body.success || normalizeSkillProfileName(body.data.name) !== name)
        return reply
          .code(400)
          .type('application/problem+json')
          .send(
            problem('INVALID_SKILL_PROFILE', 400, 'The route and body profile names must match.'),
          );
      const profile = createSkillProfile(body.data);
      const existed = await deps.readGlobalProfile(name);
      await deps.replaceGlobalProfile(profile);
      return reply.code(existed ? 200 : 201).send({ ...profile, path: deps.profilePath(name) });
    } catch (error) {
      if (error instanceof SkillProfileError)
        return reply
          .code(400)
          .type('application/problem+json')
          .send(problem('INVALID_SKILL_PROFILE', 400, 'The skill profile could not be stored.'));
      return reply
        .code(500)
        .type('application/problem+json')
        .send(
          problem(
            'SKILL_PROFILE_PERSISTENCE_FAILED',
            500,
            'The skill profile could not be stored.',
            true,
          ),
        );
    }
  });
}
