/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import type { SkillCatalog } from '../../features/skills/application/ports.js';
import { availableSkillSchema, type SkillCatalogResult } from '../../features/skills/model/skill-profile.js';
import { SkillProfileError } from '../../features/skills/model/errors.js';
import { launchCodexAppServer, type CodexProcess } from '../codex/codex-process-launcher.js';

type AppServer = Pick<CodexProcess, 'close'> & { rpc: { request(method: string, params: unknown): Promise<unknown> } };
type Launch = (input: { profile: string; cwd: string }) => AppServer;
const optionalString = z.preprocess((value) => (value === null ? undefined : value), z.string().optional());
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
  name: z.string(), description: z.string(), shortDescription: optionalString,
  interface: optionalObject(z.object({ displayName: optionalString, shortDescription: optionalString, iconSmall: optionalString, iconLarge: optionalString, brandColor: optionalString, defaultPrompt: optionalString })),
  dependencies: optionalObject(z.object({ tools: optionalObject(z.array(toolSchema)) })),
  path: z.string(), scope: optionalString, enabled: z.boolean(),
});
const resultSchema = z.object({ data: z.array(z.object({ cwd: z.string(), skills: z.array(wireSkillSchema), errors: z.array(z.unknown()) })) });

/** Short-lived Codex app-server adapter: initialize, discover, and always terminate. */
export class CodexSkillCatalog implements SkillCatalog {
  public constructor(
    private readonly profile: string,
    private readonly launch: Launch = launchCodexAppServer,
    private readonly timeoutMs = 5_000,
  ) {}

  async list(workspace: string): Promise<SkillCatalogResult> {
    const canonicalWorkspace = resolve(workspace);
    const server = this.launch({ profile: this.profile, cwd: canonicalWorkspace });
    try {
      await this.withTimeout(
        server.rpc.request('initialize', {
          clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
          capabilities: null,
        }),
      );
      const result = await this.withTimeout(server.rpc.request('skills/list', { cwds: [canonicalWorkspace], forceReload: true }));
      const parsed = resultSchema.safeParse(result);
      if (!parsed.success) throw new SkillProfileError('INVALID_SKILL_DISCOVERY', 'Invalid Codex skill catalog response.');
      const entry = parsed.data.data.find((candidate) => candidate.cwd === canonicalWorkspace);
      if (!entry) throw new SkillProfileError('INVALID_SKILL_DISCOVERY', 'Codex did not return the requested workspace catalog.');
      const skills = entry.skills.map((skill) => {
        const stable = availableSkillSchema.safeParse(skill);
        if (!stable.success) throw new SkillProfileError('INVALID_SKILL_DISCOVERY', 'Invalid Codex skill metadata.');
        return stable.data;
      });
      return {
        skills,
        errors: entry.errors.map((error) => ({ message: typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : 'Codex skill discovery error.' })),
      };
    } catch (error) {
      if (error instanceof SkillProfileError) throw error;
      throw new SkillProfileError('INVALID_SKILL_DISCOVERY', 'Codex skill discovery failed.');
    } finally {
      server.close();
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
