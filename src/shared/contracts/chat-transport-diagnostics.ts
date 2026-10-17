/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Numeric client observations are cumulative within one selection, not server facts. */
export type HistoryObservation = {
  attempts: number;
  coalesced: number;
};
export type TransportDiagnostic = {
  kind: 'history' | 'replay' | 'resync';
  durationMs: number;
  status?: number;
  after?: number;
  count?: number;
  attempts?: number;
  coalesced?: number;
};
