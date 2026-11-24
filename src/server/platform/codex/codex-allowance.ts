/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import type { CodexAllowance } from '../../../shared/contracts/codex-allowance.js';
import type { WeeklyResetCandidate } from '../../features/catalog/application/codex-auto-reset.js';
import { launchCodexAppServer, type CodexProcess } from './codex-process-launcher.js';

const windowSchema = z.object({
  windowDurationMins: z.literal(10_080),
  usedPercent: z.number().finite(),
  resetsAt: z.unknown().optional(),
});
const recordSchema = z.record(z.string(), z.unknown());

function readCodexLimits(value: unknown) {
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
  return {
    limits,
    weekly: weekly?.success ? weekly.data : undefined,
    credits: data.rateLimitResetCredits,
  };
}

/** Return only account-wide counters, never account identifiers or credit details. */
export function decodeCodexAllowance(value: unknown): CodexAllowance {
  const { weekly, credits: rawCredits } = readCodexLimits(value);
  const credits = z
    .object({ availableCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .safeParse(rawCredits);
  const reset = z.number().int().nonnegative().max(8_640_000_000_000).safeParse(weekly?.resetsAt);
  return {
    weeklyRemainingPercent: weekly
      ? Math.round(Math.max(0, Math.min(100, 100 - weekly.usedPercent)))
      : null,
    resetsAvailable: credits.success ? credits.data.availableCount : null,
    weeklyResetsAt: reset.success ? reset.data : null,
  };
}

const availableCreditSchema = z.object({
  id: z.string().min(1).max(512),
  status: z.literal('available'),
  resetType: z.literal('codexRateLimits'),
  expiresAt: z.number().int().nonnegative().nullish(),
});

export function decodeWeeklyResetCandidate(
  value: unknown,
  now: number,
): WeeklyResetCandidate | null {
  const { limits, weekly, credits } = readCodexLimits(value);
  const reached = limits.rateLimitReachedType;
  if (
    !weekly ||
    weekly.usedPercent < 100 ||
    limits.spendControlReached === true ||
    (reached != null && reached !== 'rate_limit_reached')
  )
    return null;
  const resetsAt = z.number().int().positive().max(8_640_000_000_000).safeParse(weekly.resetsAt);
  if (!resetsAt.success || resetsAt.data * 1000 <= now + 60_000) return null;
  const summary = z
    .object({ availableCount: z.number().int().positive(), credits: z.array(z.unknown()) })
    .safeParse(credits);
  if (!summary.success) return null;
  for (const row of summary.data.credits) {
    const credit = availableCreditSchema.safeParse(row);
    if (
      credit.success &&
      (credit.data.expiresAt == null || credit.data.expiresAt * 1000 > now + 10_000)
    )
      return { creditId: credit.data.id, weeklyResetsAt: resetsAt.data };
  }
  return null;
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
