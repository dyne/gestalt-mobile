/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import { thinkingLevels } from '../../../../shared/contracts/session-model-settings.js';

const schema = z.object({
  workspaceId: z.string().min(1),
  provider: z.enum(['codex', 'kimi']),
  profile: z.string().min(1),
  skillProfile: z.string().trim().min(1).optional(),
  model: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  reasoningEffort: z.enum(thinkingLevels).optional(),
  executorModel: z.string().trim().min(1).max(256).optional(),
  executorReasoningEffort: z.enum(thinkingLevels).optional(),
  sandbox: z
    .enum(['workspace-git', 'read-only', 'workspace-write', 'danger-full-access'])
    .optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
});

export type StartSessionRequest = z.infer<typeof schema>;

/** Parses only settings that are safe to send directly to Codex thread/start. */
export function parseStartSessionRequest(input: unknown): StartSessionRequest | null {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
}
