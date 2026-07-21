/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import { ancestorIds, findTreeNode } from '../filesystem-tree/tree-state.js';

export type PostCloneSelection = {
  selectedId: string | null;
  expandedIds: Set<string>;
};

export function selectAfterClone(
  previousRoots: WorkspaceOption[],
  nextRoots: WorkspaceOption[],
  destinationId: string,
  address: string,
  expandedIds: ReadonlySet<string>,
): PostCloneSelection {
  const previousRepositoryIds = new Set(
    descendants(previousRoots)
      .filter((node) => node.isGitRepository)
      .map((node) => node.id),
  );
  const destination = findTreeNode(nextRoots, destinationId);
  const candidates = destination
    ? descendants(destination.children).filter(
        (node) => node.isGitRepository && !previousRepositoryIds.has(node.id),
      )
    : [];
  const expectedName = repositoryName(address);
  const named = candidates.find((node) => node.name === expectedName);
  const repository = named ?? (candidates.length === 1 ? candidates[0] : undefined);
  const selectedId = repository?.id ?? destination?.id ?? null;
  const nextExpandedIds = new Set(expandedIds);
  if (selectedId) ancestorIds(nextRoots, selectedId).forEach((id) => nextExpandedIds.add(id));
  if (!repository && destination) nextExpandedIds.add(destination.id);
  return { selectedId, expandedIds: nextExpandedIds };
}

function descendants(roots: WorkspaceOption[]): WorkspaceOption[] {
  const nodes: WorkspaceOption[] = [];
  const visit = (node: WorkspaceOption): void => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return nodes;
}

function repositoryName(address: string): string {
  const withoutQuery = address
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const segment = withoutQuery.split(/[/:]/).at(-1) ?? '';
  return segment.replace(/\.git$/i, '');
}
