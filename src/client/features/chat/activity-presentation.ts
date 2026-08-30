/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { HistoryActivity } from './activity-summary.js';

export type ActivityPresentation = {
  kind: string;
  status?: string;
  content: string;
};

export type CommandActivitySummary = {
  successful: number;
  failed: number;
};

export function summarizeCommandActivities(
  activities: readonly HistoryActivity[],
): CommandActivitySummary {
  return activities.reduce<CommandActivitySummary>(
    (summary, activity) => {
      const presentation = presentActivity(activity);
      if (presentation?.kind !== 'Command') return summary;
      if (presentation.status === 'completed') summary.successful += 1;
      if (presentation.status === 'failed') summary.failed += 1;
      return summary;
    },
    { successful: 0, failed: 0 },
  );
}

export function presentActivity(activity: HistoryActivity): ActivityPresentation | null {
  if (isContextModeTool(activity)) return null;

  const [kind, status] = activity.label.split(' · ', 2);
  return {
    kind,
    ...(status ? { status } : {}),
    content: formatContent(kind, activity.detail),
  };
}

function isContextModeTool(activity: HistoryActivity): boolean {
  return (
    activity.label.startsWith('Tool') &&
    (activity.detail.includes('context_mode') || /(^|[_:])ctx_[a-z]/i.test(activity.detail))
  );
}

function formatContent(kind: string, detail: string): string {
  if (kind === 'Command') return unwrapBashLoginCommand(detail);
  if (kind === 'File change' || kind === 'fileChange')
    return detail.split('\n').filter(Boolean).join(', ');
  return detail;
}

function unwrapBashLoginCommand(command: string): string {
  const match = command.match(/^\/bin\/bash -lc "([\s\S]*)"$/);
  return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : command;
}
