/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { WorkspaceOption } from '../catalog/bootstrap-client.js';

export type TreeNodePolicy = (node: WorkspaceOption) => boolean;

export type VisibleTreeNode = {
  node: WorkspaceOption;
  level: number;
  parentId: string | null;
};

export const treeNodePolicies = {
  sessionBase: () => true,
  gitRepositoryTarget: (node: WorkspaceOption) => node.isGitRepository,
  cloneDestination: (node: WorkspaceOption) => !node.isGitRepository,
} satisfies Record<string, TreeNodePolicy>;

export function defaultExpandedIds(roots: WorkspaceOption[]): Set<string> {
  const expanded = new Set<string>();

  const visit = (node: WorkspaceOption, level: number): void => {
    if (!node.isGitRepository && level <= 2) expanded.add(node.id);
    node.children.forEach((child) => visit(child, level + 1));
  };

  roots.forEach((root) => visit(root, 1));
  return expanded;
}

export function toggleExpanded(
  expandedIds: ReadonlySet<string>,
  node: WorkspaceOption,
): Set<string> {
  const next = new Set(expandedIds);
  if (node.isGitRepository) return next;
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  return next;
}

export function flattenVisibleTree(
  roots: WorkspaceOption[],
  expandedIds: ReadonlySet<string>,
): VisibleTreeNode[] {
  const visible: VisibleTreeNode[] = [];

  const visit = (node: WorkspaceOption, level: number, parentId: string | null): void => {
    visible.push({ node, level, parentId });
    if (!node.isGitRepository && expandedIds.has(node.id)) {
      node.children.forEach((child) => visit(child, level + 1, node.id));
    }
  };

  roots.forEach((root) => visit(root, 1, null));
  return visible;
}

export function ancestorIds(roots: WorkspaceOption[], nodeId: string): string[] {
  const visit = (node: WorkspaceOption, ancestors: string[]): string[] | null => {
    if (node.id === nodeId) return ancestors;
    for (const child of node.children) {
      const match = visit(child, [...ancestors, node.id]);
      if (match) return match;
    }
    return null;
  };

  for (const root of roots) {
    const match = visit(root, []);
    if (match) return match;
  }
  return [];
}

export function findTreeNode(
  roots: WorkspaceOption[],
  nodeId: string,
): WorkspaceOption | undefined {
  for (const root of roots) {
    if (root.id === nodeId) return root;
    const child = findTreeNode(root.children, nodeId);
    if (child) return child;
  }
  return undefined;
}

export function refreshSelection(
  previousId: string | null,
  previousRoots: WorkspaceOption[],
  nextRoots: WorkspaceOption[],
  policy: TreeNodePolicy,
): string | null {
  if (previousId) {
    const preserved = findTreeNode(nextRoots, previousId);
    if (preserved && policy(preserved)) return preserved.id;

    const previousAncestors = ancestorIds(previousRoots, previousId);
    for (const ancestorId of previousAncestors.toReversed()) {
      const ancestor = findTreeNode(nextRoots, ancestorId);
      if (ancestor && policy(ancestor)) return ancestor.id;
    }
  }

  const fallback = flattenAll(nextRoots).find(policy);
  return fallback?.id ?? null;
}

function flattenAll(roots: WorkspaceOption[]): WorkspaceOption[] {
  const nodes: WorkspaceOption[] = [];
  const visit = (node: WorkspaceOption): void => {
    nodes.push(node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return nodes;
}
