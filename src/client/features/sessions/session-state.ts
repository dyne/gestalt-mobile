/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'resyncing' | 'offline';

export function turnReadiness(activeTurnId: string | null): string {
  return activeTurnId ? 'Codex is working…' : 'Ready.';
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const steps = [500, 1000, 2000, 5000, 10000];
  return Math.round((steps[Math.min(attempt, steps.length - 1)] ?? 10000) * (0.8 + random() * 0.4));
}
