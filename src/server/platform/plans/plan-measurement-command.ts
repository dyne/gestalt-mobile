/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PlanMeasurementSnapshot } from '../../features/plans/application/measurement-snapshot.js';

const execute = promisify(execFile);
export const PLAN_MEASUREMENT_COMMAND_TIMEOUT_MS = 15_000;

/** Invokes the explicitly configured Org Plan helper without a shell. */
export async function checkpointPlanMeasurement(
  helperPath: string,
  planPath: string,
  stepId: string,
  snapshot: PlanMeasurementSnapshot,
): Promise<void> {
  await execute(helperPath, ['measure', 'checkpoint', planPath, stepId, JSON.stringify(snapshot)], {
    shell: false,
    timeout: PLAN_MEASUREMENT_COMMAND_TIMEOUT_MS,
  });
}
