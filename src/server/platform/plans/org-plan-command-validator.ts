/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const ORG_PLAN_VALIDATION_TIMEOUT_MS = 5_000;

export type OrgPlanSkill = Readonly<{ name: string; path: string }>;
export type OrgPlanSkillDiscovery = (workspacePath: string) => Promise<readonly OrgPlanSkill[]>;

export interface WorkspaceOrgPlanValidator {
  validate(workspacePath: string, planPath: string): Promise<boolean>;
}

export type OrgPlanCommandExecute = (
  file: string,
  args: readonly string[],
  options: Readonly<{ shell: false; timeout: number; maxBuffer: number }>,
) => Promise<unknown>;

/** Runs the Org Plan skill's own validator without a shell or mutable command text. */
export class OrgPlanCommandValidator implements WorkspaceOrgPlanValidator {
  private readonly helpers = new Map<string, Promise<string | null>>();

  constructor(
    private readonly options: Readonly<{
      helperPath?: string;
      discoverSkills?: OrgPlanSkillDiscovery;
      execute?: OrgPlanCommandExecute;
    }> = {},
  ) {}

  async validate(workspacePath: string, planPath: string): Promise<boolean> {
    const helper = await this.helper(workspacePath);
    if (!helper) return false;
    try {
      await (this.options.execute ?? execute)(helper, ['validate', planPath], {
        shell: false,
        timeout: ORG_PLAN_VALIDATION_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async helper(workspacePath: string): Promise<string | null> {
    const workspace = resolve(workspacePath);
    const cached = this.helpers.get(workspace);
    if (cached) return cached;
    const discovered = this.resolveHelper(workspace);
    this.helpers.set(workspace, discovered);
    const helper = await discovered;
    if (!helper) this.helpers.delete(workspace);
    return helper;
  }

  private async resolveHelper(workspacePath: string): Promise<string | null> {
    if (this.options.helperPath)
      return isAbsolute(this.options.helperPath) ? resolve(this.options.helperPath) : null;
    if (!this.options.discoverSkills) return null;
    try {
      const skills = await this.options.discoverSkills(workspacePath);
      const skill = skills.find(({ name }) => name === 'gestalt:org-plan' || name === 'org-plan');
      return skill && isAbsolute(skill.path)
        ? join(dirname(resolve(skill.path)), 'scripts', 'org-plan')
        : null;
    } catch {
      return null;
    }
  }
}
