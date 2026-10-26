/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  parseMcpStartupStatus,
  startupToolLabel,
  startupRecoveryGuidance,
} from '../../../shared/contracts/mcp-startup-failure.js';
import type { ToastQueue } from './toast-queue.js';

/** Current notices are scoped to session/thread/tool; dismissal preserves notification history. */
export function createMcpStartupFeedback(queue: Pick<ToastQueue, 'enqueue' | 'dismiss'>) {
  const current = new Map<
    string,
    { toastId: string | null; failureId: string | null; observedAt: string; sequence?: number }
  >();
  return (
    sessionId: string,
    event: { type: string; payload: unknown; sequence?: number },
  ): void => {
    if (event.type !== 'activity.updated' || !event.payload || typeof event.payload !== 'object')
      return;
    const status = parseMcpStartupStatus((event.payload as { mcpStartup?: unknown }).mcpStartup);
    if (!status) return;
    const key = JSON.stringify([sessionId, status.threadId ?? status.runtimeId, status.serverName]);
    const before = current.get(key);
    if (
      before &&
      (before.observedAt > status.observedAt ||
        (before.sequence !== undefined &&
          event.sequence !== undefined &&
          event.sequence <= before.sequence))
    )
      return;
    if (current.size >= 256 && !before) {
      const oldest = current.entries().next().value;
      if (oldest) {
        if (oldest[1].toastId) queue.dismiss(oldest[1].toastId);
        current.delete(oldest[0]);
      }
    }
    if (status.status === 'ready') {
      if (before?.toastId) queue.dismiss(before.toastId);
      current.set(key, {
        toastId: null,
        failureId: before?.failureId ?? null,
        observedAt: status.observedAt,
        sequence: event.sequence,
      });
      return;
    }
    if (!status.failure || before?.failureId === status.failure.failureId) return;
    if (before?.toastId) queue.dismiss(before.toastId);
    const required =
      status.serverName === 'context-mode' || status.serverName === 'gestalt-context-mode';
    const toastId = queue.enqueue({
      kind: required ? 'error' : 'warning',
      code: `MCP_STARTUP_${sessionId}_${status.failure.failureId}`,
      message: `${startupToolLabel(status.serverName)} startup ${status.status}. ${startupRecoveryGuidance(status.serverName)} Trace reference: ${status.failure.failureId}.`,
    });
    current.set(key, {
      toastId,
      failureId: status.failure.failureId,
      observedAt: status.observedAt,
      sequence: event.sequence,
    });
  };
}
