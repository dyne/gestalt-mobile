/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { HistoryActivity } from './activity-summary.js';

export type ChangedFile = {
  path: string;
  additions: number | null;
  deletions: number | null;
  touchedAt?: number;
};

export function summarizeChangedFiles(activities: readonly HistoryActivity[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const activity of activities) {
    if (!activity.label.toLowerCase().replaceAll(' ', '').startsWith('filechange')) continue;
    const changes = activity.changes?.length
      ? activity.changes
      : activity.detail
          .split('\n')
          .filter(Boolean)
          .map((path) => ({ path, additions: null, deletions: null }));
    for (const change of changes) {
      const prior = files.get(change.path);
      const known = typeof change.additions === 'number' && typeof change.deletions === 'number';
      files.set(change.path, {
        path: change.path,
        additions:
          known && prior?.additions !== null ? (prior?.additions ?? 0) + change.additions : null,
        deletions:
          known && prior?.deletions !== null ? (prior?.deletions ?? 0) + change.deletions : null,
        ...(activity.occurredAt !== undefined
          ? { touchedAt: Math.max(prior?.touchedAt ?? 0, activity.occurredAt) }
          : prior?.touchedAt !== undefined
            ? { touchedAt: prior.touchedAt }
            : {}),
      });
    }
  }
  return [...files.values()];
}
