/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import { thinkingLevels } from './session-model-settings.js';

export const sessionDefaultsSchema = z
  .object({
    workspaceId: z.string().max(4096),
    skillProfile: z.string().max(256),
    provider: z.enum(['codex', 'kimi']),
    model: z.string().min(1).max(256),
    reasoningEffort: z.enum(thinkingLevels).default('medium'),
    executorModel: z.string().trim().min(1).max(256).default('gpt-5.6-terra'),
    executorReasoningEffort: z.enum(thinkingLevels).default('high'),
    sandbox: z.enum(['workspace-git', 'workspace-write', 'read-only', 'danger-full-access']),
    approvalPolicy: z.enum(['untrusted', 'on-request', 'never']),
  })
  .strict();

export type SessionDefaults = z.infer<typeof sessionDefaultsSchema>;

export interface SessionDefaultsStore {
  read(): Promise<SessionDefaults | null>;
  save(defaults: SessionDefaults): Promise<void>;
}
