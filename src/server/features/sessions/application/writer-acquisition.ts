/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { RelaySessionSnapshot } from '../model/relay-session.js';

/** Neutral failures exposed by the writer-acquisition port, never raw Codex errors. */
export type WriterAcquisitionFailureKind =
  | 'writerBusy'
  | 'rolloutMissing'
  | 'workspaceUnavailable'
  | 'runtimeDependencyFailed'
  | 'protocolIncompatible'
  | 'runtimeUnavailable';

export class WriterAcquisitionError extends Error {
  constructor(readonly kind: WriterAcquisitionFailureKind) {
    super(kind);
    this.name = 'WriterAcquisitionError';
  }
}

export type WriterAcquisition = {
  session: RelaySessionSnapshot;
  replacementCreated: boolean;
};

export function writerAcquisitionProblem(kind: WriterAcquisitionFailureKind): {
  status: number;
  code: string;
  retryable: boolean;
  detail: string;
} {
  switch (kind) {
    case 'writerBusy':
      return {
        status: 409,
        code: 'SESSION_WRITER_BUSY',
        retryable: true,
        detail: 'This thread is active in another Codex client. Release it there, then retry.',
      };
    case 'rolloutMissing':
      return {
        status: 409,
        code: 'SESSION_ROLLOUT_MISSING',
        retryable: false,
        detail: 'This stored thread is no longer available.',
      };
    case 'workspaceUnavailable':
      return {
        status: 409,
        code: 'SESSION_WORKSPACE_UNAVAILABLE',
        retryable: true,
        detail: 'The session workspace is unavailable.',
      };
    case 'runtimeDependencyFailed':
      return {
        status: 502,
        code: 'SESSION_RUNTIME_DEPENDENCY_FAILED',
        retryable: true,
        detail: 'A required Codex runtime dependency is unavailable.',
      };
    case 'protocolIncompatible':
      return {
        status: 503,
        code: 'CODEX_PROTOCOL_INCOMPATIBLE',
        retryable: false,
        detail: 'The installed Codex runtime is incompatible with this relay.',
      };
    case 'runtimeUnavailable':
      return {
        status: 503,
        code: 'SESSION_RUNTIME_UNAVAILABLE',
        retryable: true,
        detail: 'The Codex runtime is unavailable. Retry shortly.',
      };
  }
}
