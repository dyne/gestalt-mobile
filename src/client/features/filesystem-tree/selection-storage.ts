/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { WorkspaceOption } from '../catalog/bootstrap-client.js';
import { findTreeNode } from './tree-state.js';

const storageKey = 'gestalt.filesystem-tree.selection';

export function readTreeSelection(
  roots: WorkspaceOption[],
  fallback: string | null = null,
): string | null {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && findTreeNode(roots, stored)) return stored;
  } catch {
    // The current page remains usable when browser storage is unavailable.
  }
  return fallback && findTreeNode(roots, fallback) ? fallback : null;
}

export function rememberTreeSelection(selectedId: string | null): void {
  try {
    if (selectedId) localStorage.setItem(storageKey, selectedId);
    else localStorage.removeItem(storageKey);
  } catch {
    // The current selection still works when browser storage is unavailable.
  }
}
