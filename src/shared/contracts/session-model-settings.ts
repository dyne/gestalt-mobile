/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const thinkingLevels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export type SessionModelSettings = {
  reasoningEffort?: ThinkingLevel;
  executorModel?: string;
  executorReasoningEffort?: ThinkingLevel;
};
