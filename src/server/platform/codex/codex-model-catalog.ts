/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';

import type { ModelCatalog } from '../../features/catalog/application/ports.js';
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

/** Short-lived adapter for the Codex app-server model catalog. */
export class CodexModelCatalog implements ModelCatalog {
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
