/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export function submitsOnEnter(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.isComposing;
}
