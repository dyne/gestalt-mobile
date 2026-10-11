/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { LiveControlIntent, LiveRun } from './ownership.js';

/** Trusted control adapter; it never manufactures Org checkpoints or overrides user intent. */
export interface LiveControls {
  read(relayId: string): LiveControlIntent;
  hold(run: LiveRun): void;
  restore(run: LiveRun): void;
}
