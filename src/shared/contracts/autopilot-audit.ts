/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Maps durable events to the intentionally small user-visible Autopilot timeline. */
export function autopilotAuditLabel(type: string, payload: unknown): string | null {
  if (type === 'autopilot.turn-started') return 'Continued execution automatically';
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
  return null;
}

function property(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
