/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import type { CodexAllowance } from '../../../shared/contracts/codex-allowance.js';
import { launchCodexAppServer, type CodexProcess } from './codex-process-launcher.js';

const windowSchema = z.object({
  windowDurationMins: z.literal(10_080),
  usedPercent: z.number().finite(),
  resetsAt: z.unknown().optional(),
});
const recordSchema = z.record(z.string(), z.unknown());

/** Return only account-wide counters, never account identifiers or credit details. */
export function decodeCodexAllowance(value: unknown): CodexAllowance {
  const response = recordSchema.safeParse(value);
  const data = response.success ? response.data : {};
  const buckets = recordSchema.safeParse(data.rateLimitsByLimitId);
  const bucket = recordSchema.safeParse(
    buckets.success && 'codex' in buckets.data ? buckets.data.codex : data.rateLimits,
  );
  const limits =
    bucket.success && (bucket.data.limitId == null || bucket.data.limitId === 'codex')
      ? bucket.data
      : {};
  const weekly = [limits.primary, limits.secondary]
    .map((window) => windowSchema.safeParse(window))
    .find((window) => window.success);
  const credits = z
    .object({ availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .safeParse(data.rateLimitResetCredits);
  const reset = z
    .number()
    .int()
    .nonnegative()
    .max(8_640_000_000_000)
    .safeParse(weekly?.success ? weekly.data.resetsAt : null);
  return {
    weeklyRemainingPercent: weekly?.success
      ? Math.round(Math.max(0, Math.min(100, 100 - weekly.data.usedPercent)))
      : null,
    resetsAvailable: credits.success ? credits.data.availableCount : null,
    weeklyResetsAt: reset.success ? reset.data : null,
  };
}

type Server = Pick<CodexProcess, 'close'> & {
  rpc: { request(method: string, params: unknown): Promise<unknown> };
};

/** A bounded account read also works before a user has opened a session. */
export class CodexAllowanceReader {
  private pending?: Promise<CodexAllowance>;
  private cached?: { value: CodexAllowance; expires: number };

  constructor(
    private readonly cwd: string,
    private readonly launch: (input: {
      profile: string;
      cwd: string;
    }) => Server = launchCodexAppServer,
    private readonly timeoutMs = 5_000,
  ) {}

  read(): Promise<CodexAllowance> {
    if (this.cached && this.cached.expires > Date.now()) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    this.pending = this.readFresh()
      .then((value) => {
        this.cached = { value, expires: Date.now() + 30_000 };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async readFresh(): Promise<CodexAllowance> {
    const server = this.launch({ profile: '', cwd: this.cwd });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await server.rpc.request('initialize', {
            clientInfo: { name: 'gestalt-mobile', version: '0.1.0' },
            capabilities: null,
          });
          return decodeCodexAllowance(await server.rpc.request('account/rateLimits/read', {}));
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('CODEX_ALLOWANCE_UNAVAILABLE')),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      server.close();
    }
  }
}
