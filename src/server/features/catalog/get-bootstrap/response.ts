/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProfileOption, WorkspaceOption } from '../application/ports.js';
import type { ComponentVersion } from '../../../../shared/contracts/component-version.js';
import type {
  LlmProvider,
  ProviderAvailability,
} from '../../../../shared/contracts/llm-provider.js';
export type BootstrapResponse = {
  workspaces: WorkspaceOption[];
  profiles: ProfileOption[];
  models: Record<LlmProvider, string[]>;
  sessions: unknown[];
  versions: readonly ComponentVersion[];
  capabilities: {
    approvals: true;
    userInput: true;
    git: true;
    protocolCompatible: boolean;
    providers: ProviderAvailability;
  };
};
