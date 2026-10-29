/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RetrievalReadiness } from './retrieval-readiness.js';

export type XerjIndexDiagnostic = {
  id: string;
  occurredAt: string;
  code:
    | 'ambiguous-assignment'
    | 'timeout'
    | 'authentication'
    | 'connection'
    | 'capacity'
    | 'unknown-warning';
  messageDigest: string | null;
};

export type XerjStatus = {
  /** Latest warning, retained even after indexing recovers. Never contains provider prose. */
  diagnostic?: XerjIndexDiagnostic;
  readiness?: RetrievalReadiness;
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
