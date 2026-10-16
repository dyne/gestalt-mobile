/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createHash } from 'node:crypto';

const phases = new Set([
  'accept_requested',
  'agent_error',
  'carbonize_cleanup_requested',
  'carbonize_required',
  'completed',
  'discard_requested',
  'discarded',
  'generate_requested',
  'manual_edit_apply_requested',
  'steer_done',
  'steer_requested',
  'variants_ready',
]);
const kinds = new Set([
  'generate',
  'steer',
  'accept',
  'discard',
  'prefetch',
  'manual_edit_apply',
  'variant_mount_failed',
  'carbonize_cleanup',
  'timeout',
  'exit',
]);
export function helperEventIdDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}$/.test(value)
    ? createHash('sha256').update(value).digest('hex')
    : null;
}
const snapshot = (value) => ({
  idDigest: helperEventIdDigest(value?.id),
  phase: phases.has(value?.phase) ? value.phase : 'other',
  pending:
    value?.pendingEvent === null
      ? 'null'
      : value?.pendingEvent === undefined
        ? 'absent'
        : 'present',
  sourceFilePresent: typeof value?.sourceFile === 'string' && value.sourceFile.length > 0,
});
/** Test-only fixed projection. Never retain IDs, files, prompts, tokens or payloads. */
export function helperProtocolSummary(args, result) {
  return {
    command: ['live-status', 'live-resume', 'live-complete'].includes(args[0]) ? args[0] : 'other',
    targeted: args[1] === '--id',
    targetIdDigest: args[1] === '--id' ? helperEventIdDigest(args[2]) : null,
    active: typeof result?.active === 'boolean' ? result.active : null,
    activeCount: Array.isArray(result?.activeSessions) ? result.activeSessions.length : null,
    activeSessions: Array.isArray(result?.activeSessions)
      ? result.activeSessions.slice(0, 16).map(snapshot)
      : [],
    pendingCount: Array.isArray(result?.liveServer?.pendingEvents)
      ? result.liveServer.pendingEvents.length
      : null,
    pendingKinds: Array.isArray(result?.liveServer?.pendingEvents)
      ? result.liveServer.pendingEvents
          .slice(0, 16)
          .map((event) => (kinds.has(event?.type) ? event.type : 'other'))
      : [],
    snapshot: result?.snapshot ? snapshot(result.snapshot) : null,
  };
}
