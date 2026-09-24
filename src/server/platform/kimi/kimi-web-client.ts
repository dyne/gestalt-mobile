/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { KimiWebError } from './kimi-errors.js';

type Envelope<T> = {
  code: number;
  msg: string;
  data: T;
  request_id?: string;
};

/**
 * Minimal REST client for the local kimi web Server API (`kimi web`).
 * Every response is a uniform envelope where the business outcome lives in
 * `code` — HTTP status alone never reports success or failure.
 */
export class KimiWebClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  public get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  public post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  public delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new KimiWebError(-1, error instanceof Error ? error.message : String(error));
    }
    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      throw new KimiWebError(
        -1,
        `kimi web returned an unreadable response (HTTP ${response.status})`,
      );
    }
    if (typeof envelope.code !== 'number') {
      throw new KimiWebError(
        -1,
        `kimi web returned a malformed envelope (HTTP ${response.status})`,
      );
    }
    if (envelope.code !== 0) {
      throw new KimiWebError(
        envelope.code,
        envelope.msg ?? 'kimi web request failed',
        envelope.request_id,
      );
    }
    return envelope.data;
  }
}
