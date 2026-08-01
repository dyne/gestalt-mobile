/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** A framework-independent usage reading for one relay session. */
export type PlanMeasurementSnapshot = Readonly<{
  capturedAt: string;
  weeklyRemainingPercent: number | null;
  threadTokens: number | null;
}>;

/**
 * A rate-limit window normalized by the Codex adapter. Durations make window
 * selection stable when Codex changes its response ordering.
 */
export type RateLimitWindow = Readonly<{
  durationSeconds: number;
  usedPercent: number;
}>;

/**
 * The token counters which contribute independently to the thread total.
 * Cached input is deliberately separate from input because Codex reports it
 * as a distinct cumulative counter; unsupported counters are not guessed.
 */
export type ThreadTokenBreakdown = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}>;

export function createPlanMeasurementSnapshot(input: Readonly<{
  capturedAt: string;
  rateLimits?: readonly RateLimitWindow[] | null;
  tokenUsage?: ThreadTokenBreakdown | null;
}>): PlanMeasurementSnapshot {
  return Object.freeze({
    capturedAt: input.capturedAt,
    weeklyRemainingPercent: weeklyRemainingPercent(input.rateLimits),
    threadTokens: totalThreadTokens(input.tokenUsage),
  });
}

/** Returns the longest valid rate-limit window, which is the weekly window. */
export function weeklyRateLimitWindow(
  windows: readonly RateLimitWindow[] | null | undefined,
): RateLimitWindow | null {
  if (!windows) return null;
  const valid = windows.filter(
    (window) =>
      Number.isFinite(window.durationSeconds) &&
      window.durationSeconds > 0 &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 &&
      window.usedPercent <= 100,
  );
  return valid.reduce<RateLimitWindow | null>(
    (weekly, window) => (!weekly || window.durationSeconds > weekly.durationSeconds ? window : weekly),
    null,
  );
}

export function weeklyRemainingPercent(
  windows: readonly RateLimitWindow[] | null | undefined,
): number | null {
  const weekly = weeklyRateLimitWindow(windows);
  return weekly ? 100 - weekly.usedPercent : null;
}

/**
 * Adds only the three independent cumulative counters in the normalized
 * adapter contract. A missing or invalid counter makes token usage unavailable
 * instead of silently treating it as zero.
 */
export function totalThreadTokens(usage: ThreadTokenBreakdown | null | undefined): number | null {
  if (!usage || !Object.values(usage).every(isNonNegativeSafeInteger)) return null;
  const total = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
  return Number.isSafeInteger(total) ? total : null;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
