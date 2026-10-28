/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';

/** Consent only. Runtime readiness and process ownership are separate concerns. */
export const profileCapabilitiesSchema = z
  .object({ playwright: z.object({ enabled: z.boolean() }).strict() })
  .strict();

export type ProfileCapabilities = z.infer<typeof profileCapabilitiesSchema>;

export function disabledProfileCapabilities(): ProfileCapabilities {
  return { playwright: { enabled: false } };
}
