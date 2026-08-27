/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

import {
  createSessionExecutionPolicy,
  type SessionExecutionPolicy,
} from '../../features/sessions/model/relay-session.js';

/** Reads policy metadata only; prompts and model output are never retained or logged. */
export async function readRolloutExecutionPolicy(
  rolloutPath: string,
): Promise<SessionExecutionPolicy | undefined> {
  if (!isAbsolute(rolloutPath)) return undefined;
  let gestaltOrigin = false;
  let first: SessionExecutionPolicy | undefined;
  let last: SessionExecutionPolicy | undefined;
  try {
    const lines = createInterface({
      input: createReadStream(rolloutPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      const { type, payload } = record as { type?: unknown; payload?: unknown };
      if (!payload || typeof payload !== 'object') continue;
      if (type === 'session_meta') {
        gestaltOrigin = (payload as { originator?: unknown }).originator === 'gestalt-mobile';
        continue;
      }
      if (type !== 'turn_context') continue;
      const policy = decodeExecutionPolicy(payload as Record<string, unknown>);
      if (!policy) continue;
      first ??= policy;
      last = policy;
    }
  } catch {
    return undefined;
  }
  // Gestalt does not mutate policy after thread creation. Its first context is
  // therefore authoritative and cannot be contaminated by an earlier bad import.
  return gestaltOrigin ? first : last;
}

function decodeExecutionPolicy(
  payload: Record<string, unknown>,
): SessionExecutionPolicy | undefined {
  const sandboxPolicy = payload.sandbox_policy;
  const sandbox =
    sandboxPolicy && typeof sandboxPolicy === 'object'
      ? (sandboxPolicy as { type?: unknown }).type
      : undefined;
  const approvalPolicy = payload.approval_policy;
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write' && sandbox !== 'danger-full-access')
    return undefined;
  if (
    approvalPolicy !== 'untrusted' &&
    approvalPolicy !== 'on-request' &&
    approvalPolicy !== 'never'
  )
    return undefined;
  return createSessionExecutionPolicy({ sandbox, approvalPolicy });
}
