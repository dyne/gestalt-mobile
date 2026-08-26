/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type TransferKind = 'copy' | 'move';
export type TransferPhase = 'idle' | 'picking' | 'submitting' | 'conflict' | 'failed';
export type TransferState = Readonly<{
  phase: TransferPhase;
  kind?: TransferKind;
  source?: string;
  destination?: string;
  replaceAllowed?: boolean;
}>;

export const idleTransfer: TransferState = { phase: 'idle' };

export function startTransfer(kind: TransferKind, source: string): TransferState {
  return { phase: 'picking', kind, source };
}

export function pickDestination(state: TransferState, destination: string): TransferState {
  if (state.phase !== 'picking') return state;
  return { ...state, destination };
}

export function submitTransfer(state: TransferState): TransferState {
  if (state.phase !== 'picking' || state.destination === undefined) return state;
  return { ...state, phase: 'submitting' };
}

export function transferConflict(state: TransferState, replaceAllowed: boolean): TransferState {
  if (state.phase !== 'submitting') return state;
  return { ...state, phase: 'conflict', replaceAllowed };
}

export function transferFailed(state: TransferState): TransferState {
  if (state.phase !== 'submitting') return state;
  return { ...state, phase: 'failed' };
}

export function canUseDestination(state: TransferState, destination: string): boolean {
  if (state.phase !== 'picking' || !state.source) return false;
  if (state.kind === 'move' && parent(state.source) === destination) return false;
  return !(destination === state.source || destination.startsWith(`${state.source}/`));
}

export function parent(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}
