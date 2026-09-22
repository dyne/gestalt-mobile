/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SingleProviderModelCatalog } from '../catalog/provider-model-catalog.js';
import type { KimiWebServerManager } from './kimi-web-server-manager.js';

const MODELS_TIMEOUT_MS = 5_000;

/**
 * Lists kimi model aliases from a running gestalt-owned kimi web server
 * (`GET /api/v1/models`). Spawns the default profile server on demand when no
 * kimi session exists yet; any failure degrades to an empty list, matching
 * the codex catalog contract.
 */
export class KimiModelCatalog implements SingleProviderModelCatalog {
  public constructor(
    private readonly servers: KimiWebServerManager | null,
    private readonly available: boolean,
  ) {}

  public async list(): Promise<string[]> {
    if (!this.available || !this.servers) return [];
    try {
      const handle = await this.servers.ensure('default', []);
      const data = await withTimeout(
        handle.client.get('/api/v1/models'),
        MODELS_TIMEOUT_MS,
        'kimi model list timed out',
      );
      const items = Array.isArray((data as { items?: unknown })?.items)
        ? ((data as { items: unknown[] }).items as Array<Record<string, unknown>>)
        : [];
      return [
        ...new Set(
          items.flatMap((item) =>
            typeof item.model === 'string' && item.model.length > 0 && item.model.length <= 128
              ? [item.model]
              : [],
          ),
        ),
      ].sort();
    } catch {
      return [];
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(message)), timeoutMs).unref(),
    ),
  ]);
}
