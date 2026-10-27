/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { HostTestRequest } from '../../../../shared/contracts/host-tests.js';

export type HostTestOwner = { sessionId: string; workspace: string };
export interface HostTestRunner {
  request(owner: HostTestOwner, input: HostTestRequest): Promise<unknown>;
  cancelSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
