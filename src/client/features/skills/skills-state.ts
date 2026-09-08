/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  RelayAvailableSkill,
  RelaySkillList,
  RelaySkillProfile,
  RelaySkillProfileList,
} from '../sessions/relay-client.js';

export type SkillsClient = {
  listAvailableSkills(
    workspaceId: string,
    profile: string,
    refresh?: boolean,
    signal?: AbortSignal,
  ): Promise<RelaySkillList>;
  listSkillProfiles(signal?: AbortSignal): Promise<RelaySkillProfileList>;
  replaceSkillProfile(
    name: string,
    profile: Pick<RelaySkillProfile, 'version' | 'name' | 'skills'>,
  ): Promise<RelaySkillProfile>;
  deleteSkillProfile(name: string): Promise<void>;
};

export type SkillsStatus =
  | { kind: 'idle' | 'loading' | 'empty' | 'ready' | 'saving' | 'saved' | 'deleting' | 'deleted' }
  | { kind: 'warning'; message: string }
  | { kind: 'invalid-profile'; message: string }
  | { kind: 'save-failed'; message: string }
  | { kind: 'delete-failed'; message: string }
  | { kind: 'error'; message: string };

type EditableSkill = RelayAvailableSkill & { enabled: boolean };
type MissingProfileSkill = { name: string; path: string; enabled: false };

/** Feature-local orchestration for a complete, path-keyed profile snapshot. */
export class SkillsState {
  workspaceId = '';
  codexProfile = '';
  selectedProfileName = '';
  saveAsName = '';
  source: RelaySkillList['source'] = 'native';
  skills: EditableSkill[] = [];
  missingSkills: MissingProfileSkill[] = [];
  profiles: RelaySkillProfileList['profiles'] = [];
  status: SkillsStatus = { kind: 'idle' };
  private baseline = new Map<string, boolean>();
  private missingBaseline = new Map<string, { name: string; path: string; enabled: boolean }>();
  private saving = false;
  private deleting = false;
  private request: AbortController | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly client: SkillsClient) {}

  get enabledCount(): number {
    return this.skills.filter((skill) => skill.enabled).length;
  }

  get dirty(): boolean {
    return (
      this.skills.some((skill) => this.baseline.get(skill.path) !== skill.enabled) ||
      this.missingSkills.some(
        (skill) => this.missingBaseline.get(skill.path)?.enabled !== skill.enabled,
      ) ||
      [...this.missingBaseline].some(
        ([path]) => !this.missingSkills.some((skill) => skill.path === path),
      )
    );
  }

  get saveIntent(): 'create' | 'replace' {
    return this.profiles.some(
      (profile) => !('error' in profile) && profile.name === this.saveAsName.trim(),
    )
      ? 'replace'
      : 'create';
  }

  async load(workspaceId: string, codexProfile: string): Promise<void> {
    const request = this.beginRequest();
    const generation = this.generation;
    this.workspaceId = workspaceId;
    this.codexProfile = codexProfile;
    this.status = { kind: 'loading' };
    try {
      const [available, profiles] = await Promise.all([
        // The profile manager is an editing surface, so entering it must establish a
        // workspace/profile catalog instead of relying on an unrelated startup cache.
        this.client.listAvailableSkills(workspaceId, codexProfile, true, request.signal),
        this.client.listSkillProfiles(request.signal),
      ]);
      if (!this.current(generation, request)) return;
      this.applyAvailable(available);
      this.profiles = profiles.profiles;
      const invalid = profiles.profiles.find((profile) => 'error' in profile);
      if (invalid && 'error' in invalid)
        this.status = { kind: 'invalid-profile', message: invalid.error.message };
      else if (available.errors.length)
        this.status = {
          kind: 'warning',
          message: available.errors.map((error) => error.message).join(' '),
        };
      else this.status = this.skills.length ? { kind: 'ready' } : { kind: 'empty' };
    } catch (error) {
      if (!this.current(generation, request) || request.signal.aborted) return;
      this.status = { kind: 'error', message: errorMessage(error) };
    }
  }

  async refresh(): Promise<void> {
    const request = this.beginRequest();
    const generation = this.generation;
    this.status = { kind: 'loading' };
    try {
      const available = await this.client.listAvailableSkills(
        this.workspaceId,
        this.codexProfile,
        true,
        request.signal,
      );
      if (!this.current(generation, request)) return;
      this.applyAvailable(available);
      this.status = this.missingSkills.length
        ? this.missingSkillsStatus()
        : available.errors.length
          ? { kind: 'warning', message: available.errors.map((error) => error.message).join(' ') }
          : this.skills.length
            ? { kind: 'ready' }
            : { kind: 'empty' };
    } catch (error) {
      if (!this.current(generation, request) || request.signal.aborted) return;
      this.status = { kind: 'error', message: errorMessage(error) };
    }
  }

  selectProfile(name: string): void {
    const selected = this.profiles.find(
      (profile) => !('error' in profile) && profile.name === name,
    );
    if (!selected || 'error' in selected) {
      this.status = { kind: 'invalid-profile', message: 'Select a valid saved profile.' };
      return;
    }
    this.selectedProfileName = selected.name;
    this.saveAsName = selected.name;
    const enabled = new Map(selected.skills.map((skill) => [skill.path, skill.enabled]));
    const availablePaths = new Set(this.skills.map((skill) => skill.path));
    const missing = selected.skills.filter((skill) => !availablePaths.has(skill.path));
    this.skills = this.skills.map((skill) => ({
      ...skill,
      enabled: skill.alwaysAdvertised ? true : (enabled.get(skill.path) ?? false),
    }));
    this.missingSkills = missing.map((skill) => ({ ...skill, enabled: false }));
    this.baseline = new Map(this.skills.map((skill) => [skill.path, skill.enabled]));
    this.missingBaseline = new Map(missing.map((skill) => [skill.path, { ...skill }]));
    this.status = this.missingSkills.length
      ? this.missingSkillsStatus()
      : this.skills.length
        ? { kind: 'ready' }
        : { kind: 'empty' };
  }

  selectDefaultProfile(): void {
    this.selectedProfileName = '';
    this.saveAsName = '';
    this.missingSkills = [];
    this.skills = this.skills.map((skill) => ({ ...skill, enabled: skill.effectiveEnabled }));
    this.captureBaseline();
    this.status = this.skills.length ? { kind: 'ready' } : { kind: 'empty' };
  }

  toggle(path: string, enabled: boolean): void {
    this.skills = this.skills.map((skill) =>
      skill.path === path && !skill.alwaysAdvertised ? { ...skill, enabled } : skill,
    );
  }

  removeMissingSkill(path: string): void {
    this.missingSkills = this.missingSkills.filter((skill) => skill.path !== path);
    this.status = this.missingSkills.length
      ? this.missingSkillsStatus()
      : this.skills.length
        ? { kind: 'ready' }
        : { kind: 'empty' };
  }

  reset(): void {
    this.skills = this.skills.map((skill) => ({
      ...skill,
      enabled: this.baseline.get(skill.path) ?? false,
    }));
    this.missingSkills = [...this.missingBaseline.values()].map((skill) => ({
      ...skill,
      enabled: false,
    }));
    if (this.missingSkills.length) this.status = this.missingSkillsStatus();
  }

  async save(): Promise<void> {
    const name = this.saveAsName.trim();
    if (this.saving || this.deleting) return;
    if (!name) {
      this.status = { kind: 'save-failed', message: 'Enter a profile name before saving.' };
      return;
    }
    this.saving = true;
    this.status = { kind: 'saving' };
    const payload = this.savePayload(name);
    try {
      const saved = await this.client.replaceSkillProfile(name, payload);
      this.profiles = [
        ...this.profiles.filter((profile) => 'error' in profile || profile.name !== saved.name),
        saved,
      ].sort((left, right) => left.name.localeCompare(right.name));
      this.selectedProfileName = saved.name;
      this.saveAsName = saved.name;
      this.captureBaseline();
      this.status = { kind: 'saved' };
    } catch (error) {
      this.status = { kind: 'save-failed', message: errorMessage(error) };
    } finally {
      this.saving = false;
    }
  }

  async deleteSelectedProfile(): Promise<void> {
    const name = this.selectedProfileName;
    if (this.saving || this.deleting) return;
    if (!name) {
      this.status = { kind: 'delete-failed', message: 'Select a saved profile before deleting.' };
      return;
    }
    this.deleting = true;
    this.status = { kind: 'deleting' };
    try {
      await this.client.deleteSkillProfile(name);
      this.profiles = this.profiles.filter(
        (profile) => 'error' in profile || profile.name !== name,
      );
      this.selectedProfileName = '';
      this.saveAsName = '';
      this.missingSkills = [];
      this.captureBaseline();
      this.status = { kind: 'deleted' };
    } catch (error) {
      this.status = { kind: 'delete-failed', message: errorMessage(error) };
    } finally {
      this.deleting = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.request?.abort();
    this.request = null;
  }

  private beginRequest(): AbortController {
    this.request?.abort();
    this.request = new AbortController();
    ++this.generation;
    return this.request;
  }

  private current(generation: number, request: AbortController): boolean {
    return !this.disposed && generation === this.generation && this.request === request;
  }

  savePayload(
    name = this.saveAsName.trim(),
  ): Pick<RelaySkillProfile, 'version' | 'name' | 'skills'> {
    return {
      version: 1,
      name,
      skills: this.skills
        .map(({ name: skillName, path, enabled }) => ({ name: skillName, path, enabled }))
        .concat(this.missingSkills)
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  private applyAvailable(available: RelaySkillList): void {
    const explicitEdits = new Map(
      this.skills
        .filter((skill) => this.baseline.get(skill.path) !== skill.enabled)
        .map((skill) => [skill.path, skill.enabled]),
    );
    const missingByPath = new Map(this.missingSkills.map((skill) => [skill.path, skill.enabled]));
    this.source = available.source;
    this.skills = available.skills.map((skill) => ({
      ...skill,
      enabled: skill.alwaysAdvertised
        ? true
        : (explicitEdits.get(skill.path) ??
          missingByPath.get(skill.path) ??
          skill.effectiveEnabled),
    }));
    const availablePaths = new Set(available.skills.map((skill) => skill.path));
    this.missingSkills = this.missingSkills.filter((skill) => !availablePaths.has(skill.path));
    this.baseline = new Map(
      available.skills.map((skill) => [
        skill.path,
        this.baseline.get(skill.path) ?? skill.effectiveEnabled,
      ]),
    );
  }

  private captureBaseline(): void {
    this.baseline = new Map(this.skills.map((skill) => [skill.path, skill.enabled]));
    this.missingBaseline = new Map(this.missingSkills.map((skill) => [skill.path, { ...skill }]));
  }

  private missingSkillsStatus(): SkillsStatus {
    const count = this.missingSkills.length;
    return {
      kind: 'warning',
      message: `${count} saved ${count === 1 ? 'skill is' : 'skills are'} missing and disabled. Remove ${count === 1 ? 'it' : 'them'} from this profile, or restore the skill installation.`,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown relay error.';
}
