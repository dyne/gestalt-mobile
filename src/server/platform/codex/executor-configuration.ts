/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ExecutorConfigurationRead } from '../../features/plans/application/executor-model-evidence.js';
import { decodeCodexPolicyCatalog } from './codex-model-catalog.js';

type Rpc = { request(method: string, params: unknown): Promise<unknown> };
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const small = (value: unknown, bytes: number): string | null =>
  typeof value === 'string' &&
  value.trim() &&
  Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes
    ? value
    : null;

/** Metadata reads only. Never resume a child or recover settings from a request/profile/root. */
export async function readExecutorConfiguration(
  rpc: Rpc,
  input: Readonly<{ rootThreadId: string; threadId: string; taskPath: string }>,
  current: () => boolean,
  now: () => string = () => new Date().toISOString(),
  timeoutMs = 5_000,
): Promise<ExecutorConfigurationRead> {
  if (!current()) return { kind: 'unavailable', code: 'RUNTIME_UNAVAILABLE' };
  const deadline = Date.now() + timeoutMs;
  const request = async (method: string, params: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        rpc.request(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('EXECUTOR_CONFIGURATION_TIMEOUT')),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let threadResult: unknown;
  try {
    threadResult = await request('thread/read', { threadId: input.threadId, includeTurns: false });
  } catch {
    return { kind: 'unavailable', code: 'RUNTIME_UNAVAILABLE' };
  }
  const observedAt = now();
  const thread = record(record(threadResult)?.thread);
  const source = record(thread?.source);
  const spawn = record(record(source?.subAgent ?? source?.subagent)?.thread_spawn);
  if (
    !small(thread?.id, 256) ||
    !small(thread?.parentThreadId, 256) ||
    !small(spawn?.agent_path, 256)
  )
    return { kind: 'unavailable', code: 'CHILD_BINDING_UNKNOWN' };
  if (
    !thread ||
    thread.id !== input.threadId ||
    thread.parentThreadId !== input.rootThreadId ||
    spawn?.agent_path !== input.taskPath ||
    input.threadId === input.rootThreadId
  )
    return { kind: 'unavailable', code: 'CHILD_BINDING_MISMATCH' };
  const status = record(thread.status)?.type;
  if (status === 'notLoaded') return { kind: 'unavailable', code: 'CHILD_NOT_LOADED' };
  if (status !== 'idle' && status !== 'active')
    return { kind: 'unavailable', code: 'RUNTIME_UNAVAILABLE' };
  let catalog = null;
  try {
    catalog = decodeCodexPolicyCatalog(await request('model/list', {}));
  } catch {
    /* Unknown support cannot become an empty successful catalog. */
  }
  if (!current()) return { kind: 'unavailable', code: 'OBSERVATION_CHANGED' };
  const model = small(thread.model, 64);
  const reasoningEffort = small(thread.reasoningEffort, 24);
  return {
    kind: 'observed',
    configuration: {
      source: 'runtime-thread-metadata',
      observationId: randomUUID(),
      observedAt,
      model,
      reasoningEffort,
      role: small(thread.agentRole, 64),
      // Thread.updatedAt is recency, not a settings revision. Do not promote it.
      settingsRevision: null,
      settingsFingerprint: createHash('sha256')
        .update(JSON.stringify({ model, reasoningEffort }))
        .digest('hex'),
      catalog,
    },
  };
}
