/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import {
  availableSkillSchema,
  type SkillCatalogResult,
} from '../../features/skills/model/skill-profile.js';
import { SkillProfileError } from '../../features/skills/model/errors.js';

const optionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional(),
);
const optionalObject = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());
const toolSchema = z.object({
  type: z.string(),
  value: z.string(),
  description: optionalString,
  transport: optionalString,
  command: optionalString,
  url: optionalString,
});
const wireSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  shortDescription: optionalString,
  interface: optionalObject(
    z.object({
      displayName: optionalString,
      shortDescription: optionalString,
      iconSmall: optionalString,
      iconLarge: optionalString,
      brandColor: optionalString,
      defaultPrompt: optionalString,
    }),
  ),
  dependencies: optionalObject(z.object({ tools: optionalObject(z.array(toolSchema)) })),
  path: z.string(),
  scope: optionalString,
  enabled: z.boolean(),
});
const resultSchema = z.object({
  data: z.array(
    z.object({ cwd: z.string(), skills: z.array(wireSkillSchema), errors: z.array(z.unknown()) }),
  ),
});

export function decodeCodexSkills(result: unknown, workspace: string): SkillCatalogResult {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success)
    throw new SkillProfileError('INVALID_SKILL_DISCOVERY', 'Invalid Codex skill catalog response.');
  const entry = parsed.data.data.find((candidate) => candidate.cwd === resolve(workspace));
  if (!entry)
    throw new SkillProfileError(
      'INVALID_SKILL_DISCOVERY',
      'Codex did not return the requested workspace catalog.',
    );
  const skills = entry.skills.map((skill) => {
    const stable = availableSkillSchema.safeParse(skill);
    if (!stable.success)
      throw new SkillProfileError('INVALID_SKILL_DISCOVERY', 'Invalid Codex skill metadata.');
    return stable.data.name === 'gestalt:xerj' ? { ...stable.data, enabled: false } : stable.data;
  });
  return {
    skills,
    errors: entry.errors.map((error) => ({
      message:
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof error.message === 'string'
          ? error.message
          : 'Codex skill discovery error.',
    })),
  };
}
