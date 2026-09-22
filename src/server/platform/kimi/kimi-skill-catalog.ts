/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { resolve } from 'node:path';

import type { SkillCatalog } from '../../features/skills/application/ports.js';
import {
  availableSkillSchema,
  type AvailableSkill,
  type SkillCatalogResult,
} from '../../features/skills/model/skill-profile.js';
import type { KimiWebServerManager } from './kimi-web-server-manager.js';

type WorkspaceEntry = { id?: unknown; root?: unknown };
type WireSkill = {
  name?: unknown;
  description?: unknown;
  path?: unknown;
  source?: unknown;
};

const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Discovers kimi skills through a gestalt-owned kimi web server. The gestalt
 * workspace path is matched against kimi's own workspace registry (`root`),
 * then kimi's workspace-scoped skill list is mapped onto the provider-neutral
 * catalog contract. kimi reports discovered skills only, so every entry is
 * advertised as enabled; per-profile availability is gestalt-side state that
 * materialization enforces when the profile's server starts.
 */
export class KimiSkillCatalog implements SkillCatalog {
  public constructor(
    private readonly servers: KimiWebServerManager | null,
    private readonly available: boolean,
  ) {}

  public async list(workspace: string): Promise<SkillCatalogResult> {
    if (!this.available || !this.servers) return { skills: [], errors: [] };
    try {
      const handle = await this.servers.ensure('default', []);
      const canonicalWorkspace = resolve(workspace);
      const workspaces = (await withTimeout(
        handle.client.get('/api/v1/workspaces'),
        DISCOVERY_TIMEOUT_MS,
        'kimi workspace list timed out',
      )) as { items?: unknown };
      const entries = Array.isArray(workspaces.items) ? workspaces.items : [];
      const entry = entries.find(
        (candidate): candidate is WorkspaceEntry =>
          !!candidate &&
          typeof candidate === 'object' &&
          (candidate as WorkspaceEntry).root === canonicalWorkspace,
      );
      if (!entry || typeof entry.id !== 'string' || !entry.id)
        return {
          skills: [],
          errors: [{ message: 'Kimi has no registered workspace for this path yet.' }],
        };
      const data = (await withTimeout(
        handle.client.get(`/api/v1/workspaces/${entry.id}/skills`),
        DISCOVERY_TIMEOUT_MS,
        'kimi skill list timed out',
      )) as { skills?: unknown };
      const wireSkills = Array.isArray(data.skills) ? data.skills : [];
      const skills: AvailableSkill[] = [];
      const errors: SkillCatalogResult['errors'] = [];
      for (const wire of wireSkills) {
        const skill = wire as WireSkill;
        if (!skill || typeof skill !== 'object' || typeof skill.name !== 'string') continue;
        const parsed = availableSkillSchema.safeParse({
          name: skill.name,
          path:
            typeof skill.path === 'string' && skill.path.length > 0
              ? skill.path
              : `kimi://${typeof skill.source === 'string' ? skill.source : 'workspace'}/${skill.name}`,
          enabled: true,
          ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
          ...(typeof skill.source === 'string' ? { scope: `kimi:${skill.source}` } : {}),
        });
        if (parsed.success) skills.push(parsed.data);
        else errors.push({ message: `Invalid Kimi skill metadata for "${skill.name}".` });
      }
      return { skills, errors };
    } catch {
      return { skills: [], errors: [{ message: 'Kimi skill discovery failed.' }] };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(message)), timeoutMs).unref(),
    ),
  ]);
}
