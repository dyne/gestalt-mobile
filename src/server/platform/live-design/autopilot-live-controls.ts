/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { AutopilotCoordinator } from '../../features/autopilot/application/service.js';
import type { LiveControls } from '../../features/live-design/application/controls.js';
import type { LiveRun } from '../../features/live-design/application/ownership.js';
import type { SqliteLiveOwnership } from './sqlite-live-ownership.js';

/** Uses the existing durable Autopilot generation as a conservative intent version. */
export class AutopilotLiveControls implements LiveControls {
  constructor(
    private readonly coordinator: AutopilotCoordinator,
    private readonly owners: SqliteLiveOwnership,
  ) {}
  read(relayId: string) {
    return this.coordinator.controlIntent(relayId);
  }
  hold(run: LiveRun): void {
    this.owners.assert(run);
    this.coordinator.holdForLive(run.relayId);
  }
  restore(run: LiveRun): void {
    this.owners.assertRestorable(run);
    if (run.priorControls) this.coordinator.restoreAfterLive(run.relayId, run.priorControls);
  }
}
