/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isAbsolute, normalize } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { SkillProfileError } from './errors.js';

const profileNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,62})?$/;

/**
 * A path-keyed skill record. `name` is display metadata only: a skill's path is
 * its identity, because Codex may discover equal names in different scopes.
 */
export const skillSelectionEntrySchema = z
  .object({
    name: z.string().trim().min(1),
    path: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

export type SkillSelectionEntry = z.infer<typeof skillSelectionEntrySchema>;

/**
 * A complete, strict snapshot of enabled states keyed by canonical absolute
 * paths. When it is applied, discovered paths not in the snapshot are disabled.
 * The absence of a selection is distinct and preserves Codex-native state.
 */
export type SkillSelection = readonly SkillSelectionEntry[];

/** Metadata exposed by the stable skill catalog boundary, never protocol objects. */
export const availableSkillSchema = z
  .object({
    name: z.string().trim().min(1),
    path: z.string().min(1),
    enabled: z.boolean(),
    description: z.string().optional(),
    shortDescription: z.string().optional(),
    interface: z
      .object({
        displayName: z.string().optional(),
        shortDescription: z.string().optional(),
        iconSmall: z.string().optional(),
        iconLarge: z.string().optional(),
        brandColor: z.string().optional(),
        defaultPrompt: z.string().optional(),
      })
      .optional(),
    dependencies: z
      .object({
        tools: z
          .array(
            z.object({
              type: z.string(),
              value: z.string(),
              description: z.string().optional(),
              transport: z.string().optional(),
              command: z.string().optional(),
              url: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    scope: z.string().optional(),
  })
  .strict();

export type AvailableSkill = z.infer<typeof availableSkillSchema>;

/** Non-wire diagnostic retained when Codex discovers a workspace imperfectly. */
export type SkillDiscoveryError = { message: string };
export type SkillCatalogResult = { skills: AvailableSkill[]; errors: SkillDiscoveryError[] };

const profileDocumentSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1),
    skills: z.array(skillSelectionEntrySchema),
  })
  .strict();

/** A named, version-1 user-global or workspace-default skill selection. */
export type SkillProfile = {
  version: 1;
  name: string;
  skills: SkillSelection;
};

/**
 * Normalize a profile name before using it in its global filename. The output
 * is deliberately narrow so a profile name can never become a path traversal.
 */
export function normalizeSkillProfileName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (!profileNamePattern.test(normalized)) {
    throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Invalid skill profile name.');
  }
  return normalized;
}

function canonicalSkillPath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new SkillProfileError(
      'INVALID_SKILL_PROFILE',
      'Skill paths must be canonical absolute paths.',
    );
  }
  return value;
}

/**
 * Return the durable identity of a skill inside Codex's versioned plugin cache.
 * The concrete version directory is installation state, while marketplace,
 * plugin, and skill-relative path remain stable across plugin upgrades.
 */
function versionNeutralPluginSkillPath(value: string): string | undefined {
  const match = value.match(
    /^(.*[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/][^\\/]+)[\\/][^\\/]+([\\/]skills[\\/].+[\\/]SKILL\.md)$/,
  );
  return match ? `${match[1]}${match[2]}` : undefined;
}

function rebindVersionedPluginSkills(
  discovered: readonly AvailableSkill[],
  selection: SkillSelection,
): SkillSelection {
  const discoveredPaths = new Set(discovered.map((skill) => canonicalSkillPath(skill.path)));
  const discoveredByDurablePath = new Map<string, AvailableSkill[]>();
  for (const skill of discovered) {
    const durablePath = versionNeutralPluginSkillPath(canonicalSkillPath(skill.path));
    if (durablePath === undefined) continue;
    const matches = discoveredByDurablePath.get(durablePath) ?? [];
    matches.push(skill);
    discoveredByDurablePath.set(durablePath, matches);
  }

  return createSkillSelection(
    selection.map((entry) => {
      if (discoveredPaths.has(entry.path)) return entry;
      const durablePath = versionNeutralPluginSkillPath(entry.path);
      if (durablePath === undefined) return entry;
      const matches = discoveredByDurablePath.get(durablePath) ?? [];
      return matches.length === 1 ? { ...entry, path: matches[0].path } : entry;
    }),
  );
}

/**
 * Validate a complete selection and return its canonical deterministic order.
 * This is lexical only: resolving symlinks is I/O and belongs to a platform
 * adapter before it constructs this domain value.
 */
export function createSkillSelection(entries: readonly SkillSelectionEntry[]): SkillSelection {
  const paths = new Set<string>();
  const validated = entries.map((entry) => {
    const parsed = skillSelectionEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Invalid skill selection entry.');
    }
    const path = canonicalSkillPath(parsed.data.path);
    if (paths.has(path)) {
      throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Duplicate skill selection path.');
    }
    paths.add(path);
    return { ...parsed.data, path };
  });
  return validated.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Apply an optional complete selection snapshot to a fresh catalog. Selection
 * entry names are never used for matching: canonical paths are the identity.
 * Without a snapshot, the catalog retains Codex-native enabled states.
 */
export function applySkillSelectionSnapshot(
  discovered: readonly AvailableSkill[],
  selection?: SkillSelection,
): AvailableSkill[] {
  const catalog = discovered.map((skill) => {
    const parsed = availableSkillSchema.safeParse(skill);
    if (!parsed.success) {
      throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Invalid available skill.');
    }
    return { ...parsed.data, path: canonicalSkillPath(parsed.data.path) };
  });

  if (selection === undefined) {
    return catalog;
  }

  const enabledByPath = new Map(
    createSkillSelection(selection).map((entry) => [entry.path, entry.enabled]),
  );
  return catalog.map((skill) => ({ ...skill, enabled: enabledByPath.get(skill.path) ?? false }));
}

export type EffectiveSkillSelection = {
  source: 'explicit' | 'project' | 'native';
  selection: SkillSelection | undefined;
};

/** Explicit session selection takes precedence over a workspace default. */
export function selectEffectiveSkillSelection(input: {
  explicit?: SkillSelection;
  project?: SkillSelection;
}): EffectiveSkillSelection {
  if (input.explicit !== undefined)
    return { source: 'explicit', selection: createSkillSelection(input.explicit) };
  if (input.project !== undefined)
    return { source: 'project', selection: createSkillSelection(input.project) };
  return { source: 'native', selection: undefined };
}

export type CompiledSkillOverride = {
  source: EffectiveSkillSelection['source'];
  /** Undefined means no child override, preserving Codex-native configuration. */
  skillsConfig: readonly { path: string; enabled: boolean }[] | undefined;
  warnings: string[];
};

/**
 * Compile a complete, process-local `skills.config` map from fresh discovery.
 * It neither writes configuration nor mutates the user Codex installation.
 */
export function compileSkillOverride(input: {
  discovered: readonly AvailableSkill[];
  explicit?: SkillSelection;
  project?: SkillSelection;
}): CompiledSkillOverride {
  const effective = selectEffectiveSkillSelection(input);
  if (effective.selection === undefined)
    return { source: 'native', skillsConfig: undefined, warnings: [] };
  const reboundSelection = rebindVersionedPluginSkills(input.discovered, effective.selection);
  const discoveredPaths = new Set(input.discovered.map((skill) => canonicalSkillPath(skill.path)));
  const warnings = reboundSelection
    .filter((entry) => !discoveredPaths.has(entry.path))
    .map((entry) => `Saved skill path is no longer discovered: ${entry.path}`);
  const configured = applySkillSelectionSnapshot(input.discovered, reboundSelection);
  return {
    source: effective.source,
    skillsConfig: configured
      .map((skill) => ({ path: skill.path, enabled: skill.enabled }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    warnings,
  };
}

/** Construct the single profile contract shared by global and project YAML files. */
export function createSkillProfile(input: {
  name: string;
  skills: readonly SkillSelectionEntry[];
}): SkillProfile {
  return {
    version: 1,
    name: normalizeSkillProfileName(input.name),
    skills: createSkillSelection(input.skills),
  };
}

/** Parse the version-1 YAML document without performing filesystem access. */
export function parseSkillProfileYaml(source: string): SkillProfile {
  const document = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new SkillProfileError('INVALID_SKILL_PROFILE_YAML', 'Invalid skill profile YAML.');
  }
  const parsed = profileDocumentSchema.safeParse(document.toJS());
  if (!parsed.success) {
    throw new SkillProfileError('INVALID_SKILL_PROFILE', 'Invalid skill profile document.');
  }
  return createSkillProfile(parsed.data);
}

/** Serialize the canonical version-1 YAML document in deterministic path order. */
export function serializeSkillProfileYaml(profile: SkillProfile): string {
  const canonical = createSkillProfile(profile);
  return stringify({ version: 1, name: canonical.name, skills: canonical.skills });
}
