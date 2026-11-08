/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SkillProfileStore } from './ports.js';
import type { SkillProfile } from '../model/skill-profile.js';

export type GlobalSkillProfileRead =
  | { name: string; profile: SkillProfile }
  | { name: string; error: { code: 'INVALID_SKILL_PROFILE'; message: string } };

/** Shared list semantics: retain invalid/disappeared profiles as recoverable read errors. */
export async function readGlobalSkillProfiles(
  store: Pick<SkillProfileStore, 'listGlobalProfileNames' | 'readGlobalProfile'>,
): Promise<GlobalSkillProfileRead[]> {
  const names = await store.listGlobalProfileNames();
  return Promise.all(
    names
      .sort((a, b) => a.localeCompare(b))
      .map(async (name): Promise<GlobalSkillProfileRead> => {
        try {
          const profile = await store.readGlobalProfile(name);
          return profile
            ? { name: profile.name, profile }
            : {
                name,
                error: {
                  code: 'INVALID_SKILL_PROFILE',
                  message: 'Profile disappeared while reading.',
                },
              };
        } catch (error) {
          return {
            name,
            error: {
              code: 'INVALID_SKILL_PROFILE',
              message: error instanceof Error ? error.message : 'Invalid profile.',
            },
          };
        }
      }),
  );
}
