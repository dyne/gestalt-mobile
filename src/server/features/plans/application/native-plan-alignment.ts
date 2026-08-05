/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SupervisedPlan } from '../domain/supervised-plan.js';

export type NativePlanAlignment = 'unknown' | 'aligned' | 'stale';
type NativeStep = Readonly<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>;

/** Ephemeral diagnostic only; it deliberately never feeds the Org registry. */
export class NativePlanAlignmentRegistry {
  private readonly states = new Map<string, NativePlanAlignment>();
  observe(sessionId: string, threadId: string | null, params: unknown): NativePlanAlignment {
    const parsed = parse(params);
    if (!threadId || !parsed || parsed.threadId !== threadId) return this.states.get(sessionId) ?? 'unknown';
    const expected = this.expected(sessionId);
    if (!expected) return 'unknown';
    const next: NativePlanAlignment = same(expected, parsed.plan) ? 'aligned' : 'stale';
    this.states.set(sessionId, next); return next;
  }
  read(sessionId: string): NativePlanAlignment { return this.states.get(sessionId) ?? 'unknown'; }
  clear(sessionId: string): void { this.states.delete(sessionId); this.plans.delete(sessionId); }
  private readonly plans = new Map<string, readonly NativeStep[]>();
  private expected(sessionId: string): readonly NativeStep[] | null { return this.plans.get(sessionId) ?? null; }
  replace(sessionId: string, plan: SupervisedPlan): void {
    const l1 = plan.steps.filter((step) => step.level === 1);
    this.plans.set(sessionId, l1.map((step, index) => ({ step: `L1 ${index + 1}/${l1.length} — ${step.title}`, status: step.state === 'TODO' ? 'pending' : step.state === 'WIP' || step.reviewStatus === 'UNREVIEWED' ? 'inProgress' : 'completed' })));
    this.states.set(sessionId, 'unknown');
  }
}
function parse(value: unknown): Readonly<{ threadId: string; plan: readonly NativeStep[] }> | null {
  if (!value || typeof value !== 'object') return null; const record = value as Record<string, unknown>;
  if (typeof record.threadId !== 'string' || !Array.isArray(record.plan)) return null;
  const plan = record.plan.flatMap((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).step === 'string' && ['pending', 'inProgress', 'completed'].includes((item as Record<string, unknown>).status as string) ? [{ step: (item as Record<string, string>).step, status: (item as Record<string, NativeStep['status']>).status }] : []);
  return plan.length === record.plan.length ? { threadId: record.threadId, plan } : null;
}
function same(left: readonly NativeStep[], right: readonly NativeStep[]): boolean { return left.length === right.length && left.every((step, i) => step.step === right[i]?.step && step.status === right[i]?.status); }
