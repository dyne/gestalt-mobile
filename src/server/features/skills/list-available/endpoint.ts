/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ProfileCatalog, WorkspaceCatalog } from '../../catalog/application/ports.js';
import type { SkillCatalog, SkillProfileStore } from '../application/ports.js';
import { applySkillSelectionSnapshot } from '../model/skill-profile.js';
import { SkillProfileError } from '../model/errors.js';
import { problem } from '../../../platform/http/problem.js';

const querySchema = z.object({ workspaceId: z.string().min(1), profile: z.string().min(1) }).strict();

export type ListAvailableSkillsDependencies = {
  workspaces: Pick<WorkspaceCatalog, 'resolve'>;
  profiles: Pick<ProfileCatalog, 'require'>;
  catalog(profile: string): SkillCatalog;
  selections: Pick<SkillProfileStore, 'readWorkspaceDefault'>;
};

/** Register the workspace-scoped skill discovery REPR slice. */
export function registerListAvailableSkills(app: FastifyInstance, deps: ListAvailableSkillsDependencies): void {
  app.get('/api/skills', async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success)
      return reply.code(400).type('application/problem+json').send(problem('INVALID_SKILL_REQUEST', 400, 'workspaceId and profile are required.'));
    try {
      const [workspace, profile] = await Promise.all([
        deps.workspaces.resolve(parsed.data.workspaceId),
        deps.profiles.require(parsed.data.profile),
      ]);
      const [discovered, project] = await Promise.all([
        deps.catalog(profile.name).list(workspace.realPath),
        deps.selections.readWorkspaceDefault(workspace.realPath),
      ]);
      const skills = project
        ? applySkillSelectionSnapshot(discovered.skills, project.skills)
        : discovered.skills;
      return {
        source: project ? 'project' : 'native',
        errors: discovered.errors.map(({ message }) => ({ message })),
        skills: [...skills]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((skill) => ({
            name: skill.name,
            description: skill.description,
            shortDescription: skill.shortDescription,
            displayName: skill.interface?.displayName,
            interfaceShortDescription: skill.interface?.shortDescription,
            iconSmall: skill.interface?.iconSmall,
            iconLarge: skill.interface?.iconLarge,
            brandColor: skill.interface?.brandColor,
            defaultPrompt: skill.interface?.defaultPrompt,
            dependencies: skill.dependencies,
            path: skill.path,
            scope: skill.scope,
            nativeEnabled: discovered.skills.find((native) => native.path === skill.path)?.enabled ?? false,
            effectiveEnabled: skill.enabled,
          })),
      };
    } catch (error) {
      if (error instanceof Error && (error.message === 'WORKSPACE_NOT_FOUND' || error.message === 'PROFILE_NOT_FOUND'))
        return reply.code(404).type('application/problem+json').send(problem(error.message, 404, 'The requested catalog entry was not found.'));
      const code = error instanceof SkillProfileError && error.code === 'INVALID_SKILL_PROFILE' ? 'INVALID_SKILL_PROFILE' : 'SKILL_DISCOVERY_FAILED';
      return reply.code(502).type('application/problem+json').send(problem(code, 502, 'Skill discovery could not be completed.', true));
    }
  });
}
