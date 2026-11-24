/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';

export type CodexAllowance = {
  weeklyRemainingPercent: number | null;
  weeklyResetsAt: number | null;
  resetsAvailable: number | null;
};

export const codexAutoResetStatusSchema = z.object({
  enabled: z.boolean(),
  resets: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        occurredAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }),
    )
    .max(50),
});

export type CodexAutoResetStatus = z.infer<typeof codexAutoResetStatusSchema>;
