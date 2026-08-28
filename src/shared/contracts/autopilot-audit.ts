/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Maps durable events to the intentionally small user-visible Autopilot timeline. */
export function autopilotAuditLabel(type: string, payload: unknown): string | null {
  if (type === 'autopilot.turn-started') return 'Continued execution automatically';
  if (type === 'autopilot.final-rejected') return 'Kept incomplete supervised work active';
  if (type === 'autopilot.executor-resumed') return 'Resumed the assigned executor';
  if (type === 'autopilot.process-monitoring') return 'Monitoring executor background work';
  if (type === 'autopilot.process-result-consumed') return 'Consumed background work result';
  if (type === 'autopilot.process-terminated')
    return property(payload, 'reason') === 'resourceBudget'
      ? 'Stopped background work at its resource limit'
      : 'Stopped executor background work';
  if (type === 'autopilot.turn-failed') {
    const code = property(payload, 'code');
    return code === 'START_UNAVAILABLE'
      ? 'Automatic continuation could not start: session runtime unavailable'
      : 'Automatic continuation failed';
  }
  if (type === 'org-plan.attention-required') return 'Needs attention';
  if (type === 'org-plan.attention-resolved')
    return property(payload, 'outcome') === 'failed'
      ? 'Attention resolution failed'
      : 'Attention resolved';
  if (type !== 'autopilot.updated') return null;

  const state = property(payload, 'state');
  const reason = property(payload, 'reason');
  if (state === 'completed') return 'Completed the supervised plan';
  if (state === 'attentionRequired' && reason === 'noPlanProgress')
    return 'Automatic continuation stopped: no agent progress';
  if (state === 'attentionRequired' && reason === 'reconcileFailed')
    return 'Automatic continuation stopped: agent status unavailable';
  if (state === 'attentionRequired' && reason === 'actionRateExceeded')
    return 'Automatic continuation stopped: too many automatic actions';
  return null;
}

function property(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
