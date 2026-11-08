/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  OrgPlanLaunchRequest,
  OrgPlanLaunchResult,
} from '../../../shared/contracts/org-plan-execution.js';

export type OrgPlanLaunchIntent = Omit<OrgPlanLaunchRequest, 'launchId'>;
export type OrgPlanLaunchState = Readonly<{ submitting: boolean; error: string | null }>;

/** Transport only: confirmation, notifications and session navigation belong to callers. */
export class OrgPlanLaunchController {
  #state: OrgPlanLaunchState = { submitting: false, error: null };
  #intent: string | null = null;
  #launchId: string | null = null;
  #disposed = false;
  constructor(
    private readonly transport: {
      startOrgPlanSupervision(input: OrgPlanLaunchRequest): Promise<OrgPlanLaunchResult>;
    },
    private readonly createId: () => string,
    private readonly onChange: (state: OrgPlanLaunchState) => void,
  ) {}
  get state(): OrgPlanLaunchState {
    return this.#state;
  }
  async submit(intent: OrgPlanLaunchIntent): Promise<OrgPlanLaunchResult | null> {
    if (this.#disposed || this.#state.submitting) return null;
    const reference = intent.reference;
    const identity = JSON.stringify([
      reference.kind,
      reference.kind === 'workspace' ? reference.workspaceId : reference.sessionId,
      reference.kind === 'retained-session' ? null : reference.planName,
      intent.expectedRevision,
      intent.skillProfile ?? null,
    ]);
    if (identity !== this.#intent) {
      this.#intent = identity;
      this.#launchId = this.createId();
    }
    this.#publish({ submitting: true, error: null });
    try {
      const result = await this.transport.startOrgPlanSupervision({
        ...intent,
        launchId: this.#launchId!,
      });
      return this.#disposed ? null : result;
    } catch (error) {
      this.#publish({
        submitting: false,
        error: error instanceof Error ? error.message : 'Could not start supervision.',
      });
      return null;
    } finally {
      this.#publish({ ...this.#state, submitting: false });
    }
  }
  dispose(): void {
    this.#disposed = true;
  }
  #publish(state: OrgPlanLaunchState): void {
    if (!this.#disposed) {
      this.#state = state;
      this.onChange(state);
    }
  }
}
