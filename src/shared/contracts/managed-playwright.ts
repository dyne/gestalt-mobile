/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';

export const managedPlaywrightRequestSchema = z
  .object({
    capability: z.literal('playwright'),
    action: z.enum(['start', 'status', 'stop']),
    planId: z.string().min(1).max(256).optional(),
  })
  .strict();

export const gestaltManagedPlaywrightDynamicTool = {
  type: 'function',
  name: 'gestalt_managed_playwright',
  description:
    'Request, inspect or release managed browser access for this root session. Profile consent is required. Start/stop may remain pending until a safe owned-runtime resume; tools and browser guidance are usable only after connected verification. Never starts a turn or clears Manual Off or attention. No commands, paths or environment accepted.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['capability', 'action'],
    properties: {
      capability: { type: 'string', enum: ['playwright'] },
      action: { type: 'string', enum: ['start', 'status', 'stop'] },
      planId: { type: 'string', minLength: 1, maxLength: 256 },
    },
  },
} as const;

export function isManagedPlaywrightCall(input: { method: string; params: unknown }): boolean {
  return (
    input.method === 'item/tool/call' &&
    !!input.params &&
    typeof input.params === 'object' &&
    (input.params as { tool?: unknown }).tool === gestaltManagedPlaywrightDynamicTool.name
  );
}
