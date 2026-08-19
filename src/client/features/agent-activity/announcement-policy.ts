/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { AgentActivitySnapshot } from './contracts.js';

const announcementLabel = (state: AgentActivitySnapshot['root']['state']) =>
  ({
    working: 'working',
    idle: 'idle',
    awaitingAgent: 'waiting for child',
    awaitingHuman: 'needs you',
    blocked: 'blocked',
    disconnected: 'disconnected',
  })[state];

export function activityAnnouncement(
  previous: AgentActivitySnapshot | null,
  next: AgentActivitySnapshot | null,
): { polite: string; critical: string } {
  if (!next) return { polite: '', critical: '' };
  const changed =
    !previous ||
    previous.root.state !== next.root.state ||
    previous.aggregateSubagents !== next.aggregateSubagents;
  const critical = next.root.state === 'blocked' || next.root.state === 'awaitingHuman';
  return {
    polite: changed
      ? `Supervisor ${announcementLabel(next.root.state)}; subagents ${announcementLabel(next.aggregateSubagents)}.`
      : '',
    critical:
      critical && (!previous || previous.root.state !== next.root.state)
        ? `Supervisor ${announcementLabel(next.root.state)}.`
        : '',
  };
}
