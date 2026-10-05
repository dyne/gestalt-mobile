/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { AutopilotSession } from './autopilot-session.js';
import type { ExecutorCommand } from './supervised-lifecycle.js';
import { MAX_AUTOPILOT_RECORD_BYTES } from './plan-fingerprint.js';

/** Terminal evidence cannot become dispatchable again. Issued resumes are never replayed. */
export function canTransitionExecutorCommand(
  from: ExecutorCommand['status'],
  to: ExecutorCommand['status'],
  idempotentProcessAction = false,
): boolean {
  if (from === 'failed' && idempotentProcessAction) return to === 'issued';
  return from === 'scheduled'
    ? ['issued', 'cancelled', 'superseded'].includes(to)
    : from === 'issued' && ['accepted', 'failed', 'cancelled', 'superseded'].includes(to);
}

/** Keep unresolved work. Evict oldest terminal evidence by both count and bytes. */
export function retainExecutorCommands(
  state: AutopilotSession,
  command: ExecutorCommand,
): readonly ExecutorCommand[] | undefined {
  const commands = [...(state.executor?.commands ?? []), command];
  const fits = () => {
    const candidate = { ...state, executor: { ...state.executor, commands } };
    // SQLite stores lifecycle JSON inside its row. Double encoding the entire
    // state is a conservative bound, with room for row names and status changes.
    return (
      commands.length <= 32 &&
      new TextEncoder().encode(JSON.stringify(JSON.stringify(candidate))).byteLength <=
        MAX_AUTOPILOT_RECORD_BYTES - 4096
    );
  };
  while (!fits()) {
    const index = commands.findIndex((entry) => !['scheduled', 'issued'].includes(entry.status));
    if (index < 0) return undefined;
    commands.splice(index, 1);
  }
  return commands;
}
