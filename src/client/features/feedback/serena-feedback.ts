/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ToastInput } from './toast-queue.js';

/** Bound optional-service failures to the shared warning pipeline, without raw MCP errors. */
export function serenaAvailabilityFeedback(event: {
  type: string;
  payload: unknown;
}): ToastInput | null {
  if (event.type !== 'activity.updated' || !event.payload || typeof event.payload !== 'object')
    return null;
  const payload = event.payload as { id?: unknown; label?: unknown };
  if (payload.id !== 'gestalt-serena-availability' || payload.label !== 'Serena unavailable')
    return null;
  return {
    kind: 'warning',
    code: 'SERENA_UNAVAILABLE',
    message:
      'Serena is unavailable in this session. Use native code tools. Connection availability will be checked when the runtime resumes.',
  };
}
