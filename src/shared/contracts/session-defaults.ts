/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import { thinkingLevels } from './session-model-settings.js';
import type { LlmProvider } from './llm-provider.js';

/** Normal New session defaults, shared by the form and server preparation. */
export const newSessionFallback = {
  model: 'gpt-6.1-sol',
  reasoningEffort: 'medium',
  executorModel: 'gpt-5.6-terra',
  executorReasoningEffort: 'high',
  sandbox: 'workspace-git',
  approvalPolicy: 'never',
} as const;

export function defaultProviderModel(provider: LlmProvider, models: readonly string[]): string {
  return provider === 'codex' && models.includes(newSessionFallback.model)
    ? newSessionFallback.model
    : (models[0] ?? (provider === 'codex' ? newSessionFallback.model : ''));
}

export const sessionDefaultsSchema = z
  .object({
    workspaceId: z.string().max(4096),
    skillProfile: z.string().max(256),
    provider: z.enum(['codex', 'kimi']),
    model: z.string().min(1).max(256),
    reasoningEffort: z.enum(thinkingLevels).default(newSessionFallback.reasoningEffort),
    executorModel: z.string().trim().min(1).max(256).default(newSessionFallback.executorModel),
    executorReasoningEffort: z
      .enum(thinkingLevels)
      .default(newSessionFallback.executorReasoningEffort),
    sandbox: z.enum(['workspace-git', 'workspace-write', 'read-only', 'danger-full-access']),
    approvalPolicy: z.enum(['untrusted', 'on-request', 'never']),
  })
  .strict();

export type SessionDefaults = z.infer<typeof sessionDefaultsSchema>;

/** Saved provider-specific models never cross providers. Explicit saved models are not substituted. */
export function resolveNewSessionDefaults(
  saved: SessionDefaults | null | undefined,
  provider: LlmProvider,
  models: readonly string[],
): SessionDefaults {
  return {
    workspaceId: saved?.workspaceId ?? '',
    skillProfile: saved?.skillProfile ?? '',
    provider,
    model: saved?.provider === provider ? saved.model : defaultProviderModel(provider, models),
    reasoningEffort: saved?.reasoningEffort ?? newSessionFallback.reasoningEffort,
    executorModel: saved?.executorModel ?? newSessionFallback.executorModel,
    executorReasoningEffort:
      saved?.executorReasoningEffort ?? newSessionFallback.executorReasoningEffort,
    sandbox: saved?.sandbox ?? newSessionFallback.sandbox,
    approvalPolicy: saved?.approvalPolicy ?? newSessionFallback.approvalPolicy,
  };
}

export interface SessionDefaultsStore {
  read(): Promise<SessionDefaults | null>;
  save(defaults: SessionDefaults): Promise<void>;
}
