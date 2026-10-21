/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { RuntimeExecutorConfiguration } from '../../features/plans/application/executor-model-evidence.js';

import { launchCodexAppServer, type CodexProcess } from './codex-process-launcher.js';

type AppServer = Pick<CodexProcess, 'close'> & {
  rpc: { request(method: string, params: unknown): Promise<unknown> };
};
type Launch = (input: { profile: string; cwd: string }) => AppServer;

const modelSchema = z.object({ id: z.string().min(1) });
const resultSchema = z.union([
  z.object({ data: z.array(modelSchema) }),
  z.object({ models: z.array(modelSchema) }),
  z.object({ data: z.object({ models: z.array(modelSchema) }) }),
]);

/** Bounded policy catalog from the same model/list source; missing effort support stays unknown. */
export function decodeCodexPolicyCatalog(value: unknown): RuntimeExecutorConfiguration['catalog'] {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!record || (record.nextCursor !== undefined && record.nextCursor !== null)) return null;
  const nested =
    record.data && typeof record.data === 'object'
      ? (record.data as Record<string, unknown>)
      : null;
  const rows = Array.isArray(record.data) ? record.data : (record.models ?? nested?.models);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 512) return null;
  const schema = z.object({
    id: z.string().min(1).max(128),
    supportedReasoningEfforts: z
      .array(z.object({ reasoningEffort: z.string().min(1).max(24) }))
      .min(1)
      .max(16),
  });
  const models: { id: string; reasoningEfforts: string[] }[] = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) return null;
    const efforts = parsed.data.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
    if (new Set(efforts).size !== efforts.length) return null;
    models.push({ id: parsed.data.id, reasoningEfforts: efforts.sort() });
  }
  if (new Set(models.map((model) => model.id)).size !== models.length) return null;
  models.sort((a, b) => a.id.localeCompare(b.id));
  return {
    source: 'runtime',
    revision: createHash('sha256').update(JSON.stringify(models)).digest('hex'),
    models,
  };
}

/** Short-lived adapter for the Codex app-server model catalog. */
export class CodexModelCatalog {
  public constructor(
    private readonly cwd: string,
    private readonly launch: Launch = launchCodexAppServer,
    private readonly timeoutMs = 5_000,
  ) {}

  async list(): Promise<string[]> {
    const server = this.launch({ profile: '', cwd: this.cwd });
    try {
      await this.withTimeout(
        server.rpc.request('initialize', {
          clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
          capabilities: null,
        }),
      );
      const result = resultSchema.safeParse(
        await this.withTimeout(server.rpc.request('model/list', {})),
      );
      if (!result.success) return [];
      const models =
        'models' in result.data
          ? result.data.models
          : Array.isArray(result.data.data)
            ? result.data.data
            : result.data.data.models;
      return [...new Set(models.map((model) => model.id))].sort((left, right) =>
        left.localeCompare(right),
      );
    } catch {
      return [];
    } finally {
      server.close();
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Codex model discovery timed out.')),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
