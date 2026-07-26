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
  listAvailableSkills(workspaceId: string, profile: string): Promise<RelaySkillList>;
  listSkillProfiles(): Promise<RelaySkillProfileList>;
  replaceSkillProfile(
    name: string,
    profile: Pick<RelaySkillProfile, 'version' | 'name' | 'skills'>,
  ): Promise<RelaySkillProfile>;
};

export type SkillsStatus =
  | { kind: 'idle' | 'loading' | 'empty' | 'ready' | 'saving' | 'saved' }
  | { kind: 'warning'; message: string }
  | { kind: 'invalid-profile'; message: string }
  | { kind: 'save-failed'; message: string }
  | { kind: 'error'; message: string };

type EditableSkill = RelayAvailableSkill & { enabled: boolean };

/** Feature-local orchestration for a complete, path-keyed profile snapshot. */
export class SkillsState {
  workspaceId = '';
  codexProfile = '';
  selectedProfileName = '';
  saveAsName = '';
  source: RelaySkillList['source'] = 'native';
  skills: EditableSkill[] = [];
  profiles: RelaySkillProfileList['profiles'] = [];
  status: SkillsStatus = { kind: 'idle' };
  private baseline = new Map<string, boolean>();
  private saving = false;

  constructor(private readonly client: SkillsClient) {}

  get enabledCount(): number {
    return this.skills.filter((skill) => skill.enabled).length;
  }

  get dirty(): boolean {
    return this.skills.some((skill) => this.baseline.get(skill.path) !== skill.enabled);
  }

  get saveIntent(): 'create' | 'replace' {
    return this.profiles.some(
      (profile) => !('error' in profile) && profile.name === this.saveAsName.trim(),
    )
      ? 'replace'
      : 'create';
  }

  async load(workspaceId: string, codexProfile: string): Promise<void> {
    this.workspaceId = workspaceId;
    this.codexProfile = codexProfile;
    this.status = { kind: 'loading' };
    try {
      const [available, profiles] = await Promise.all([
        this.client.listAvailableSkills(workspaceId, codexProfile),
        this.client.listSkillProfiles(),
      ]);
      this.applyAvailable(available);
      this.profiles = profiles.profiles;
      const invalid = profiles.profiles.find((profile) => 'error' in profile);
      if (invalid && 'error' in invalid)
        this.status = { kind: 'invalid-profile', message: invalid.error.message };
      else if (available.errors.length)
        this.status = { kind: 'warning', message: available.errors.map((error) => error.message).join(' ') };
      else this.status = this.skills.length ? { kind: 'ready' } : { kind: 'empty' };
    } catch (error) {
      this.status = { kind: 'error', message: errorMessage(error) };
    }
  }

  selectProfile(name: string): void {
    const selected = this.profiles.find((profile) => !('error' in profile) && profile.name === name);
    if (!selected || 'error' in selected) {
      this.status = { kind: 'invalid-profile', message: 'Select a valid saved profile.' };
      return;
    }
    this.selectedProfileName = selected.name;
    this.saveAsName = selected.name;
    const enabled = new Map(selected.skills.map((skill) => [skill.path, skill.enabled]));
    this.skills = this.skills.map((skill) => ({ ...skill, enabled: enabled.get(skill.path) ?? false }));
    this.captureBaseline();
    this.status = this.skills.length ? { kind: 'ready' } : { kind: 'empty' };
  }

  toggle(path: string, enabled: boolean): void {
    this.skills = this.skills.map((skill) => (skill.path === path ? { ...skill, enabled } : skill));
  }

  reset(): void {
    this.skills = this.skills.map((skill) => ({ ...skill, enabled: this.baseline.get(skill.path) ?? false }));
  }

  async save(): Promise<void> {
    const name = this.saveAsName.trim();
    if (this.saving) return;
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

  savePayload(name = this.saveAsName.trim()): Pick<RelaySkillProfile, 'version' | 'name' | 'skills'> {
    return {
      version: 1,
      name,
      skills: this.skills
        .map(({ name: skillName, path, enabled }) => ({ name: skillName, path, enabled }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  private applyAvailable(available: RelaySkillList): void {
    const explicitEdits = new Map(
      this.skills
        .filter((skill) => this.baseline.get(skill.path) !== skill.enabled)
        .map((skill) => [skill.path, skill.enabled]),
    );
    this.source = available.source;
    this.skills = available.skills.map((skill) => ({
      ...skill,
      enabled: explicitEdits.get(skill.path) ?? skill.effectiveEnabled,
    }));
    this.baseline = new Map(
      available.skills.map((skill) => [skill.path, this.baseline.get(skill.path) ?? skill.effectiveEnabled]),
    );
  }

  private captureBaseline(): void {
    this.baseline = new Map(this.skills.map((skill) => [skill.path, skill.enabled]));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown relay error.';
}
