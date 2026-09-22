/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProviderAvailability } from '../../../../shared/contracts/llm-provider.js';

export type HealthResponse = {
  status: 'ok' | 'degraded';
  version: string;
  codex: { installedVersion: string | null; protocolVersion: string | null; compatible: boolean };
  providers: ProviderAvailability;
};
