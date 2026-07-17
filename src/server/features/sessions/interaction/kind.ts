/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type RelayInteractionKind =
  'commandApproval' | 'fileChangeApproval' | 'permissionsApproval' | 'userInput';
export function isInteractionKind(value: string): value is RelayInteractionKind {
  return ['commandApproval', 'fileChangeApproval', 'permissionsApproval', 'userInput'].includes(
    value,
  );
}
