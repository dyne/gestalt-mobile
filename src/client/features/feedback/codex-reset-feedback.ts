/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { CodexAutoResetStatus } from '../../../shared/contracts/codex-allowance.js';
import type { ToastQueue } from './toast-queue.js';

const storageKey = 'gestalt-mobile.codex-auto-reset-last-seen';

export function createCodexResetFeedback(
  queue: Pick<ToastQueue, 'enqueue' | 'historySnapshot'>,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
) {
  function storedWatermark(): number {
    try {
      const value = Number(storage?.getItem(storageKey));
      return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }
  let watermark = storedWatermark();
  return (resets: CodexAutoResetStatus['resets']): void => {
    const known = new Set(queue.historySnapshot().map((entry) => entry.code));
    for (const reset of [...resets].sort((a, b) => a.occurredAt - b.occurredAt)) {
      if (reset.occurredAt <= watermark) continue;
      const code = `CODEX_WEEKLY_RESET_${reset.id}`;
      if (!known.has(code)) {
        queue.enqueue({
          code,
          kind: 'info',
          message: 'Gestalt used a reset credit for the Codex weekly allowance.',
        });
        known.add(code);
      }
      watermark = reset.occurredAt;
      try {
        storage?.setItem(storageKey, String(Math.max(watermark, storedWatermark())));
      } catch {
        // The current browser view still deduplicates without local storage.
      }
    }
  };
}
