/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import {
  ancestorIds,
  defaultExpandedIds,
  flattenVisibleTree,
  refreshSelection,
  toggleExpanded,
  treeNodePolicies,
} from './tree-state.js';

const folder = (
  id: string,
  children: WorkspaceOption[] = [],
  isGitRepository = false,
): WorkspaceOption => ({
  id,
  name: id === '.' ? 'workspace' : (id.split('/').at(-1) ?? id),
  relativePath: id,
  isGitRepository,
  children,
});

const repository = (id: string): WorkspaceOption => folder(id, [], true);

const tree = [
  folder('.', [
    folder('group', [
      folder('group/nested', [repository('group/nested/repository')]),
      repository('group/project'),
    ]),
    folder('empty'),
  ]),
];

describe('tree expansion state', () => {
  it('opens root and first-level ordinary folders by default while keeping deeper folders folded', () => {
    const expanded = defaultExpandedIds(tree);

    expect([...expanded]).toEqual(['.', 'group', 'empty']);
    expect(flattenVisibleTree(tree, expanded).map(({ node }) => node.id)).toEqual([
      '.',
      'group',
      'group/nested',
      'group/project',
      'empty',
    ]);
  });

  it('flattens only expanded branches with stable levels and parents', () => {
    const visible = flattenVisibleTree(tree, new Set(['.', 'group', 'group/nested']));

    expect(visible.map(({ node, level, parentId }) => [node.id, level, parentId])).toEqual([
      ['.', 1, null],
      ['group', 2, '.'],
      ['group/nested', 3, 'group'],
      ['group/nested/repository', 4, 'group/nested'],
      ['group/project', 3, 'group'],
      ['empty', 2, '.'],
    ]);
  });

  it('toggles ordinary folders without mutating input and never toggles repository leaves', () => {
    const initial = new Set(['.']);
    const expanded = toggleExpanded(initial, tree[0]!.children[0]!);
    const collapsed = toggleExpanded(expanded, tree[0]!.children[0]!);
    const repositoryResult = toggleExpanded(collapsed, repository('project'));

    expect(initial).toEqual(new Set(['.']));
    expect(expanded).toEqual(new Set(['.', 'group']));
    expect(collapsed).toEqual(new Set(['.']));
    expect(repositoryResult).toEqual(collapsed);
    expect(repositoryResult).not.toBe(collapsed);
  });
});

describe('tree selection refresh', () => {
  it('returns ancestors from root to immediate parent', () =>
    expect(ancestorIds(tree, 'group/nested/repository')).toEqual(['.', 'group', 'group/nested']));

  it('preserves an eligible selection that remains after refresh', () =>
    expect(
      refreshSelection('group', tree, structuredClone(tree), treeNodePolicies.sessionBase),
    ).toBe('group'));

  it('falls back to the nearest surviving eligible ancestor after refresh', () => {
    const refreshed = [folder('.', [folder('group')])];

    expect(
      refreshSelection('group/nested/repository', tree, refreshed, treeNodePolicies.sessionBase),
    ).toBe('group');
  });

  it('falls back to the first eligible node or null when no eligible node remains', () => {
    expect(refreshSelection('missing', tree, tree, treeNodePolicies.gitRepositoryTarget)).toBe(
      'group/nested/repository',
    );
    expect(
      refreshSelection('missing', tree, [folder('.')], treeNodePolicies.gitRepositoryTarget),
    ).toBeNull();
  });
});

describe('consumer selection policies', () => {
  const ordinary = folder('destination');
  const repo = repository('repository');

  it('allows any directory as a session base', () => {
    expect(treeNodePolicies.sessionBase(ordinary)).toBe(true);
    expect(treeNodePolicies.sessionBase(repo)).toBe(true);
  });

  it('allows only repositories as Git targets', () => {
    expect(treeNodePolicies.gitRepositoryTarget(ordinary)).toBe(false);
    expect(treeNodePolicies.gitRepositoryTarget(repo)).toBe(true);
  });

  it('allows only ordinary folders as clone destinations', () => {
    expect(treeNodePolicies.cloneDestination(ordinary)).toBe(true);
    expect(treeNodePolicies.cloneDestination(repo)).toBe(false);
  });
});
