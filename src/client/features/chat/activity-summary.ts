/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FileChangeSummary } from '../../../shared/contracts/file-change.js';

export type HistoryActivity = {
  id: string;
  label: string;
  detail: string;
  turnId?: string;
  occurredAt?: number;
  changes?: FileChangeSummary[];
};

function fileChangeSummaries(value: unknown): FileChangeSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((change) => {
    if (!change || typeof change !== 'object') return [];
    const item = change as Record<string, unknown>;
    return typeof item.path === 'string' &&
      Number.isInteger(item.additions) &&
      (item.additions as number) >= 0 &&
      Number.isInteger(item.deletions) &&
      (item.deletions as number) >= 0
      ? [
          {
            path: item.path,
            additions: item.additions as number,
            deletions: item.deletions as number,
          },
        ]
      : [];
  });
}

export function toActivity(item: Record<string, unknown>): HistoryActivity | null {
  if (typeof item.id !== 'string') return null;
  const owner = {
    ...(typeof item.turnId === 'string' ? { turnId: item.turnId } : {}),
    ...(typeof item.occurredAt === 'number' && Number.isFinite(item.occurredAt)
      ? { occurredAt: item.occurredAt }
      : {}),
  };
  if (item.kind === 'reasoning' && Array.isArray(item.summary)) {
    const detail = item.summary
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    return detail ? { id: item.id, label: 'Reasoning summary', detail, ...owner } : null;
  }
  if (item.kind === 'plan' && typeof item.text === 'string')
    return { id: item.id, label: 'Plan', detail: item.text, ...owner };
  if (item.kind === 'command' && typeof item.command === 'string')
    return {
      id: item.id,
      label: `Command · ${String(item.status ?? 'unknown')}`,
      detail: item.command,
      ...owner,
    };
  if (item.kind === 'fileChange' && Array.isArray(item.paths)) {
    const changes = fileChangeSummaries(item.changes);
    return {
      id: item.id,
      label: `File change · ${String(item.status ?? 'unknown')}`,
      detail: item.paths.join('\n'),
      ...(changes.length ? { changes } : {}),
      ...owner,
    };
  }
  if (item.kind === 'tool' && typeof item.name === 'string')
    return {
      id: item.id,
      label: `Tool · ${String(item.status ?? 'unknown')}`,
      detail: item.name,
      ...owner,
    };
  return null;
}
