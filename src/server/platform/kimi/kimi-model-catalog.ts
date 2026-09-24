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
 * (`GET /api/v1/models`) when a Kimi profile server is already running.
 * Discovery is deliberately read-only: bootstrap must not spawn or wait for
 * Kimi on behalf of an otherwise ordinary Codex client. Explicit Kimi session
 * activation owns server startup; any discovery failure degrades to an empty
 * list, matching the catalog contract.
 */
export class KimiModelCatalog implements SingleProviderModelCatalog {
  public constructor(
    private readonly servers: KimiWebServerManager | null,
    private readonly available: boolean,
  ) {}

  public async list(): Promise<string[]> {
    if (!this.available || !this.servers) return [];
    try {
      const handle = this.servers.list()[0];
      if (!handle) return [];
      return await this.read(handle);
    } catch {
      return [];
    }
  }

  /** Explicit Kimi session setup may start its isolated default server. */
  public async listForSession(): Promise<string[]> {
    if (!this.available || !this.servers) return [];
    try {
      return await this.read(await this.servers.ensure('default', []));
    } catch {
      return [];
    }
  }

  private async read(handle: {
    client: { get(path: string): Promise<unknown> };
  }): Promise<string[]> {
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
