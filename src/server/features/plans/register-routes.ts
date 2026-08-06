/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { registerClosePlan } from './close-plan/endpoint.js';
import { registerGetPlanMeasurement } from './get-measurement/endpoint.js';
import { registerGetPlan } from './get-plan/endpoint.js';
import { registerGetWorkspacePlan } from './get-workspace-plan/endpoint.js';
import { registerListWorkspacePlans } from './list-workspace-plans/endpoint.js';

export function registerPlanRoutes(
  app: FastifyInstance,
  deps: Pick<AppDependencies, 'planRoutes' | 'workspacePlanRoutes' | 'planMeasurementRoutes'>,
): void {
  if (deps.planRoutes) {
    registerGetPlan(app, deps.planRoutes);
    registerClosePlan(app, deps.planRoutes);
  }
  if (deps.workspacePlanRoutes) {
    registerListWorkspacePlans(app, deps.workspacePlanRoutes);
    registerGetWorkspacePlan(app, deps.workspacePlanRoutes);
  }
  if (deps.planMeasurementRoutes) registerGetPlanMeasurement(app, deps.planMeasurementRoutes);
}
