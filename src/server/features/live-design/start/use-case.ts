/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  AppIdentity,
  LiveOwnershipStore,
  LiveRun,
  LiveStartClaim,
} from '../application/ownership.js';
import type { LiveControls } from '../application/controls.js';

export type LiveStartRequest = {
  relayId: string;
  appId: string;
  targetId: string;
  operationId: string;
  authSessionHash: string;
  deviceId: string;
};
/** Only trusted composition supplies these adapters; there is no public URL/path admission. */
export interface LiveStartAdmission {
  /** Resolve registry identities and verify the registered loopback listener before quiescing. */
  register(request: LiveStartRequest): Promise<LiveStartClaim>;
  /** Undo only this registration attempt; never unregister the shared target or stop its server. */
  unregister(claim: LiveStartClaim): Promise<void>;
  /** Includes root, descendants, outstanding approvals and unknown activity. Never interrupts busy work. */
  busy(claim: LiveStartClaim): Promise<boolean>;
  /** Revalidate auth, app inode, target/process identity and isolation of EVERY project/agent process. */
  verify(run: LiveRun): Promise<void>;
}
export interface LiveStartResources {
  /** Settle idle control writers; refuse readiness if the full process tree cannot be proved idle. */
  quiesce(run: LiveRun): Promise<void>;
  /** Undo this attempt's suspension; a retained Live claim still blocks ordinary dispatch. */
  restore(run: LiveRun): Promise<void>;
  prepare(run: LiveRun): Promise<void>;
  /** Settle attempted IO and clean only verified-owned resources; external dev servers survive. */
  cleanup(run: LiveRun): Promise<void>;
  authorize(run: LiveRun): Promise<void>;
  revoke(run: LiveRun): Promise<void>;
  expose(run: LiveRun): Promise<void>;
  remove(run: LiveRun): Promise<void>;
}
export type LiveStartDependencies = {
  owners: LiveOwnershipStore;
  controls: LiveControls;
  admission: LiveStartAdmission;
  resources: LiveStartResources;
  revalidateApp(app: AppIdentity): void;
};

/** Durable intent precedes each IO; stale callbacks never roll back another generation's resources. */
export async function startLive(
  deps: LiveStartDependencies,
  request: LiveStartRequest,
): Promise<LiveRun> {
  const claim = await deps.admission.register(request);
  let run: LiveRun;
  try {
    const retry = deps.owners.retry(claim);
    if (retry) {
      await deps.admission.unregister(claim);
      return retry;
    }
    if (await deps.admission.busy(claim)) throw new Error('LIVE_SESSION_BUSY');
    const result = deps.owners.claim(claim);
    if (!result.acquired) {
      await deps.admission.unregister(claim);
      return result.run;
    }
    run = result.run;
  } catch (error) {
    await deps.admission.unregister(claim);
    throw error;
  }
  const rollback: Array<{ phase: string; undo(run: LiveRun): Promise<void> }> = [
    { phase: 'registration', undo: () => deps.admission.unregister(claim) },
  ];
  const assert = () => {
    deps.owners.assert(run);
    deps.revalidateApp(run.app);
  };
  const step = async (
    phase: string,
    perform: (run: LiveRun) => Promise<void>,
    undo: (run: LiveRun) => Promise<void>,
  ) => {
    assert();
    run = deps.owners.mutate(run, { event: 'phase', phase: `${phase}:intent` });
    // Include attempted acquisition: an exception may follow a successful external action.
    rollback.push({ phase, undo });
    await perform(run);
    assert();
    run = deps.owners.mutate(run, { event: 'phase', phase: `${phase}:ack` });
  };
  try {
    assert();
    run = deps.owners.mutate(run, {
      event: 'captureControls',
      intent: deps.controls.read(run.relayId),
    });
    deps.controls.hold(run);
    await deps.admission.verify(run);
    assert();
    await step(
      'quiesce',
      deps.resources.quiesce.bind(deps.resources),
      deps.resources.restore.bind(deps.resources),
    );
    await step(
      'prepare',
      deps.resources.prepare.bind(deps.resources),
      deps.resources.cleanup.bind(deps.resources),
    );
    await step(
      'authorize',
      deps.resources.authorize.bind(deps.resources),
      deps.resources.revoke.bind(deps.resources),
    );
    // Registration is insufficient: recheck current auth and all process boundaries before exposure.
    await deps.admission.verify(run);
    assert();
    await step(
      'route',
      deps.resources.expose.bind(deps.resources),
      deps.resources.remove.bind(deps.resources),
    );
    return deps.owners.mutate(run, { event: 'ready' });
  } catch (error) {
    // Controller takeover/Stop owns reconciliation of any late IO; an old callback may do nothing.
    deps.owners.assert(run);
    let cleanupFailed = false;
    for (const { phase, undo } of rollback.reverse()) {
      deps.owners.assert(run);
      run = deps.owners.mutate(run, { event: 'phase', phase: `rollback:${phase}:intent` });
      try {
        await undo(run);
        deps.owners.assert(run);
        run = deps.owners.mutate(run, { event: 'phase', phase: `rollback:${phase}:ack` });
      } catch {
        cleanupFailed = true;
      }
      deps.owners.assert(run);
    }
    run = deps.owners.mutate(run, {
      event: cleanupFailed ? 'recover' : 'failed',
      code: cleanupFailed ? 'LIVE_CLEANUP_REQUIRED' : 'LIVE_START_FAILED',
    });
    throw error;
  }
}
