/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { PlanState } from './plan-controller.js';
import type { WorkspaceOrgPreview } from '../sessions/relay-client.js';

export function planFileReferences(state: PlanState | WorkspaceOrgPreview | null): string[] {
  const paths = new Set<string>();
  const collect = (text: string) => {
    for (const match of text.matchAll(/=([^=\n]+)=/g)) {
      const path = match[1]!.trim();
      if (path) paths.add(path);
    }
  };
  if (state?.kind === 'org-source') collect(state.source);
  else if (state && 'plan' in state && state.plan) {
    const pending = [...state.plan.steps];
    while (pending.length) {
      const step = pending.pop()!;
      Object.values(step.description).forEach((value) => {
        if (value) collect(value);
      });
      pending.push(...step.children);
    }
  }
  return [...paths];
}
