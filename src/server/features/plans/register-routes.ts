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
import { registerOpenPlan } from './open-plan/endpoint.js';
import { registerArchiveWorkspacePlan } from './archive-workspace-plan/endpoint.js';
import { registerPrepareOrgPlanSupervision } from './prepare-supervision/endpoint.js';
import { registerExecuteOrgPlan } from './execute-plan/endpoint.js';
import { registerDownloadOrgPlan } from './download-plan/endpoint.js';

export function registerPlanRoutes(
  app: FastifyInstance,
  deps: Pick<
    AppDependencies,
    | 'planRoutes'
    | 'workspacePlanRoutes'
    | 'planMeasurementRoutes'
    | 'prepareOrgPlanRoutes'
    | 'executeOrgPlanRoutes'
    | 'downloadOrgPlanRoutes'
  >,
): void {
  if (deps.prepareOrgPlanRoutes) registerPrepareOrgPlanSupervision(app, deps.prepareOrgPlanRoutes);
  if (deps.executeOrgPlanRoutes) registerExecuteOrgPlan(app, deps.executeOrgPlanRoutes);
  if (deps.downloadOrgPlanRoutes) registerDownloadOrgPlan(app, deps.downloadOrgPlanRoutes);
  if (deps.planRoutes) {
    registerGetPlan(app, deps.planRoutes);
    registerClosePlan(app, deps.planRoutes);
    registerOpenPlan(app, deps.planRoutes);
  }
  if (deps.workspacePlanRoutes) {
    registerListWorkspacePlans(app, deps.workspacePlanRoutes);
    registerGetWorkspacePlan(app, deps.workspacePlanRoutes);
    if (deps.workspacePlanRoutes.archiver)
      registerArchiveWorkspacePlan(app, {
        workspaces: deps.workspacePlanRoutes.workspaces,
        archiver: deps.workspacePlanRoutes.archiver,
      });
  }
  if (deps.planMeasurementRoutes) registerGetPlanMeasurement(app, deps.planMeasurementRoutes);
}
