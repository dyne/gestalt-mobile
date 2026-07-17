/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProfileOption, WorkspaceOption } from '../application/ports.js';
export type BootstrapResponse = {
  workspaces: WorkspaceOption[];
  profiles: ProfileOption[];
  sessions: unknown[];
  capabilities: { approvals: true; userInput: true; git: true; protocolCompatible: boolean };
};
