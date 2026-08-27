/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { SkillProfileError } from './errors.js';
import {
  applySkillSelectionSnapshot,
  compileSkillOverride,
  createSkillProfile,
  createSkillSelection,
  parseSkillProfileYaml,
  serializeSkillProfileYaml,
} from './skill-profile.js';

const alpha = { name: 'Alpha', path: '/skills/alpha/SKILL.md', enabled: true };
const beta = { name: 'Beta', path: '/skills/beta/SKILL.md', enabled: false };

describe('skill profile codec', () => {
  it.each([
    {
      label: 'global profile',
      yaml: 'version: 1\nname: work\nskills:\n  - name: Alpha\n    path: /skills/alpha/SKILL.md\n    enabled: true\n',
    },
    {
      label: 'project default',
      yaml: 'version: 1\nname: project\nskills: []\n',
    },
  ])('round-trips a valid $label document', ({ yaml }) => {
    const profile = parseSkillProfileYaml(yaml);
    expect(parseSkillProfileYaml(serializeSkillProfileYaml(profile))).toEqual(profile);
  });

  it.each([
    ['duplicate paths', [alpha, { ...alpha, name: 'Copy' }]],
    ['relative path', [{ ...alpha, path: 'skills/alpha/SKILL.md' }]],
    ['noncanonical path', [{ ...alpha, path: '/skills/alpha/../alpha/SKILL.md' }]],
  ])('rejects $0', (_label, skills) => {
    expect(() => createSkillSelection(skills)).toThrow(SkillProfileError);
  });

  it.each(['../escape', 'work/profile', '.hidden', 'a'.repeat(64)])(
    'rejects unsafe profile name %s',
    (name) => expect(() => createSkillProfile({ name, skills: [] })).toThrow(SkillProfileError),
  );

  it.each([
    'version: 2\nname: work\nskills: []\n',
    'version: 1\nname: work\nskills: []\nunknown: true\n',
    'version: 1\nname: work\nskills:\n  - name: Alpha\n    path: /skills/alpha/SKILL.md\n    enabled: true\n    unknown: true\n',
  ])('rejects unknown versions and fields', (yaml) => {
    expect(() => parseSkillProfileYaml(yaml)).toThrow(SkillProfileError);
  });

  it('accepts an empty strict snapshot', () => {
    expect(createSkillProfile({ name: 'Empty profile', skills: [] })).toEqual({
      version: 1,
      name: 'empty-profile',
      skills: [],
    });
  });

  it('serializes selections by path regardless of input order', () => {
    const profile = createSkillProfile({ name: 'Work', skills: [beta, alpha] });
    expect(serializeSkillProfileYaml(profile)).toBe(
      'version: 1\nname: work\nskills:\n  - name: Alpha\n    path: /skills/alpha/SKILL.md\n    enabled: true\n  - name: Beta\n    path: /skills/beta/SKILL.md\n    enabled: false\n',
    );
  });

  it('retains stale saved names while keeping paths as identity', () => {
    const profile = parseSkillProfileYaml(
      'version: 1\nname: work\nskills:\n  - name: Old display name\n    path: /skills/current/SKILL.md\n    enabled: true\n',
    );
    expect(profile.skills[0]).toEqual({
      name: 'Old display name',
      path: '/skills/current/SKILL.md',
      enabled: true,
    });
  });

  it('applies a strict snapshot by path and disables newly discovered paths', () => {
    const discovered = [
      { ...alpha, enabled: false },
      { ...beta, enabled: true },
      { name: 'New skill', path: '/skills/new/SKILL.md', enabled: true },
    ];
    const selection = createSkillSelection([
      { ...alpha, name: 'Stale Alpha name', enabled: true },
      { name: 'Removed skill', path: '/skills/removed/SKILL.md', enabled: true },
    ]);

    expect(applySkillSelectionSnapshot(discovered, selection)).toEqual([
      { ...alpha, enabled: true },
      { ...beta, enabled: false },
      { name: 'New skill', path: '/skills/new/SKILL.md', enabled: false },
    ]);
  });

  it('preserves native catalog states when no profile snapshot exists', () => {
    const discovered = [
      { ...alpha, enabled: false },
      { ...beta, enabled: true },
    ];
    expect(applySkillSelectionSnapshot(discovered)).toEqual(discovered);
  });

  it('keeps every Gestalt skill advertised across stale or restrictive snapshots', () => {
    const current = {
      name: 'gestalt:org-plan',
      path: '/plugins/cache/market/gestalt/2.2.0/skills/org-plan/SKILL.md',
      enabled: false,
    };
    const newlyAdded = {
      name: 'gestalt:new-workflow',
      path: '/plugins/cache/market/gestalt/2.2.0/skills/new-workflow/SKILL.md',
      enabled: false,
    };
    const staleSnapshot = createSkillSelection([
      {
        name: current.name,
        path: '/plugins/cache/market/gestalt/2.1.0/skills/org-plan/SKILL.md',
        enabled: false,
      },
    ]);

    expect(applySkillSelectionSnapshot([current, newlyAdded], staleSnapshot)).toEqual([
      { ...current, enabled: true },
      { ...newlyAdded, enabled: true },
    ]);
    expect(applySkillSelectionSnapshot([current])).toEqual([{ ...current, enabled: true }]);
  });

  it('keeps discovered context-mode advertised across absent, restrictive, and stale selections', () => {
    const currentPath =
      '/home/test/.codex/plugins/cache/dyne-gestalt-agents/gestalt/2.2.0/skills/context-mode/SKILL.md';
    const stalePath =
      '/home/test/.codex/plugins/cache/dyne-gestalt-agents/gestalt/2.1.0/skills/context-mode/SKILL.md';
    const contextMode = { name: 'gestalt:context-mode', path: currentPath, enabled: false };
    const restrictive = createSkillSelection([{ ...contextMode, enabled: false }]);

    expect(applySkillSelectionSnapshot([contextMode])).toEqual([{ ...contextMode, enabled: true }]);
    expect(
      compileSkillOverride({ discovered: [contextMode, alpha], explicit: restrictive })
        .skillsConfig,
    ).toEqual([
      { path: currentPath, enabled: true },
      { path: alpha.path, enabled: false },
    ]);
    expect(
      compileSkillOverride({
        discovered: [contextMode],
        project: createSkillSelection([
          { name: 'previous context mode', path: stalePath, enabled: false },
        ]),
      }),
    ).toEqual({
      source: 'project',
      skillsConfig: [{ path: currentPath, enabled: true }],
      warnings: [],
    });
  });

  it('prefers explicit selection, disables new paths, and warns for stale paths', () => {
    const result = compileSkillOverride({
      discovered: [
        { ...alpha, enabled: false },
        { ...beta, enabled: true },
      ],
      project: createSkillSelection([{ ...alpha, enabled: true }]),
      explicit: createSkillSelection([
        { ...beta, name: 'Renamed', enabled: false },
        { name: 'Gone', path: '/skills/gone/SKILL.md', enabled: true },
      ]),
    });
    expect(result).toEqual({
      source: 'explicit',
      skillsConfig: [
        { path: '/skills/alpha/SKILL.md', enabled: false },
        { path: '/skills/beta/SKILL.md', enabled: false },
      ],
      warnings: ['Saved skill path is no longer discovered: /skills/gone/SKILL.md'],
    });
  });

  it('rebinds a saved plugin skill across cache versions', () => {
    const currentPath =
      '/home/test/.codex/plugins/cache/dyne-gestalt-agents/gestalt/2.2.0/skills/development-testing/SKILL.md';
    const result = compileSkillOverride({
      discovered: [
        { name: 'gestalt:development-testing', path: currentPath, enabled: false },
        { ...alpha, enabled: true },
      ],
      explicit: createSkillSelection([
        {
          name: 'gestalt:development-testing',
          path: '/home/test/.codex/plugins/cache/dyne-gestalt-agents/gestalt/2.1.0/skills/development-testing/SKILL.md',
          enabled: true,
        },
      ]),
    });

    expect(result).toEqual({
      source: 'explicit',
      skillsConfig: [
        { path: currentPath, enabled: true },
        { path: '/skills/alpha/SKILL.md', enabled: false },
      ],
      warnings: [],
    });
  });

  it('does not rebind a stale plugin skill to a different plugin or skill path', () => {
    const stalePath =
      '/home/test/.codex/plugins/cache/dyne-gestalt-agents/gestalt/2.1.0/skills/development-testing/SKILL.md';
    const result = compileSkillOverride({
      discovered: [
        {
          name: 'other:development-testing',
          path: '/home/test/.codex/plugins/cache/other-marketplace/other-plugin/2.2.0/skills/development-testing/SKILL.md',
          enabled: true,
        },
        {
          name: 'gestalt:verification-before-completion',
          path: '/home/test/.codex/plugins/cache/dyne-gestalt-agents/gestalt/2.2.0/skills/verification-before-completion/SKILL.md',
          enabled: true,
        },
      ],
      explicit: createSkillSelection([
        { name: 'gestalt:development-testing', path: stalePath, enabled: true },
      ]),
    });

    expect(result.skillsConfig).toEqual([
      {
        path: '/home/test/.codex/plugins/cache/dyne-gestalt-agents/gestalt/2.2.0/skills/verification-before-completion/SKILL.md',
        enabled: true,
      },
      {
        path: '/home/test/.codex/plugins/cache/other-marketplace/other-plugin/2.2.0/skills/development-testing/SKILL.md',
        enabled: false,
      },
    ]);
    expect(result.warnings).toEqual([`Saved skill path is no longer discovered: ${stalePath}`]);
  });

  it('emits no override when neither explicit nor project selection exists', () => {
    expect(compileSkillOverride({ discovered: [alpha] })).toEqual({
      source: 'native',
      skillsConfig: undefined,
      warnings: [],
    });
  });
});
