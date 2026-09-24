/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** LLM providers the relay can drive; each session belongs to exactly one. */
export type LlmProvider = 'codex' | 'kimi';

export const llmProviders: readonly LlmProvider[] = ['codex', 'kimi'];

/** Per-provider availability reported by bootstrap and health. */
export type ProviderAvailability = {
  codex: { available: boolean; version?: string };
  kimi: { available: boolean; version?: string };
};
