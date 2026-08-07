/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile, lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { SkillProfileStore } from '../../features/skills/application/ports.js';
import {
  normalizeSkillProfileName,
  parseSkillProfileYaml,
  serializeSkillProfileYaml,
  type SkillProfile,
} from '../../features/skills/model/skill-profile.js';
import { SkillProfileError } from '../../features/skills/model/errors.js';

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Filesystem adapter with injected home directory; no process-global home lookup. */
export class FilesystemSkillProfileStore implements SkillProfileStore {
  public constructor(private readonly homeDirectory: string) {}

  /** Absolute canonical location of one normalized global profile. */
  globalProfilePath(name: string): string {
    return join(
      resolve(this.homeDirectory),
      '.gestalt',
      'skill-profiles',
      `${normalizeSkillProfileName(name)}.yml`,
    );
  }

  async listGlobalProfileNames(): Promise<string[]> {
    const root = await this.globalRoot();
    try {
      const entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
        .map((entry) => entry.name.slice(0, -4))
        .filter((name) => {
          try {
            return normalizeSkillProfileName(name) === name;
          } catch {
            return false;
          }
        })
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  async readGlobalProfile(name: string): Promise<SkillProfile | undefined> {
    const path = this.globalProfilePath(name);
    return this.readProfile(path);
  }

  async replaceGlobalProfile(profile: SkillProfile): Promise<void> {
    const name = normalizeSkillProfileName(profile.name);
    const root = await this.globalRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = join(root, `${name}.yml`);
    const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, serializeSkillProfileYaml(profile), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async deleteGlobalProfile(name: string): Promise<boolean> {
    const normalizedName = normalizeSkillProfileName(name);
    const root = await this.globalRoot();
    const path = join(root, `${normalizedName}.yml`);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Profile must be a regular file.');
      }
      await rm(path);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  async readWorkspaceDefault(workspace: string): Promise<SkillProfile | undefined> {
    const root = await realpath(workspace);
    const path = resolve(root, 'gestalt-skills.yml');
    if (dirname(path) !== root) {
      throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Workspace profile escaped its root.');
    }
    return this.readProfile(path);
  }

  private async globalRoot(): Promise<string> {
    const home = resolve(this.homeDirectory);
    const root = resolve(home, '.gestalt', 'skill-profiles');
    if (!root.startsWith(`${home}/`)) {
      throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Global profile root escaped home.');
    }
    try {
      const stat = await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new SkillProfileError(
          'INVALID_SKILL_PROFILE',
          'Global profile root must be a directory.',
        );
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return root;
  }

  private async readProfile(path: string): Promise<SkillProfile | undefined> {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Profile must be a regular file.');
      }
      return parseSkillProfileYaml(await readFile(path, 'utf8'));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }
}
