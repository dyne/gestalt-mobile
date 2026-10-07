/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type XerjStatus = {
  mode: 'auto' | 'manual' | 'off';
  state:
    | 'disabled'
    | 'starting'
    | 'absent'
    | 'indexing'
    | 'watching'
    | 'shared'
    | 'ready'
    | 'error'
    | 'stopped';
  root: string;
  namespace?: string;
  phase?: string;
  percent?: number;
  files?: number;
  records?: number;
  lastUpdate?: string;
  message?: string;
};
