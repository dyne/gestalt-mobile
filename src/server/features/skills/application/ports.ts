/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SkillProfile } from '../model/skill-profile.js';
import type { SkillCatalogResult } from '../model/skill-profile.js';

/** Persistence boundary for named user profiles and one workspace default. */
export interface SkillProfileStore {
  listGlobalProfileNames(): Promise<string[]>;
  readGlobalProfile(name: string): Promise<SkillProfile | undefined>;
  replaceGlobalProfile(profile: SkillProfile): Promise<void>;
  readWorkspaceDefault(workspace: string): Promise<SkillProfile | undefined>;
}

/** Fresh Codex discovery boundary; it returns domain metadata, not JSON-RPC values. */
export interface SkillCatalog {
  list(workspace: string): Promise<SkillCatalogResult>;
}
