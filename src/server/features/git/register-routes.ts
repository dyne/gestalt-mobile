/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

import type { AppDependencies } from '../../app.js';
import { registerCheckoutBranch } from './checkout-branch/endpoint.js';
import { registerCloneRepository } from './clone-repository/endpoint.js';
import { registerGetGitSummary } from './get-summary/endpoint.js';
import { registerPullRebase } from './pull-rebase/endpoint.js';
import { registerPushUpstream } from './push-upstream/endpoint.js';
import { registerRefreshGit } from './refresh/endpoint.js';

export function registerGitRoutes(
  app: FastifyInstance,
  deps: Pick<AppDependencies, 'gitSummary'>,
): void {
  const git = deps.gitSummary;
  if (!git) return;
  registerGetGitSummary(app, { workspaces: git.workspaces, inspect: git.inspect });
  registerPushUpstream(app, {
    workspaces: git.workspaces,
    inspect: git.inspectForPush ?? git.inspect,
    push: git.push,
    idempotency: git.idempotency,
  });
  registerRefreshGit(app, {
    workspaces: git.workspaces,
    refresh: git.refresh,
    idempotency: git.idempotency,
  });
  if (git.pull && git.checkout) {
    registerPullRebase(app, { workspaces: git.workspaces, pull: git.pull });
    registerCheckoutBranch(app, { workspaces: git.workspaces, checkout: git.checkout });
  }
  if (git.clone) registerCloneRepository(app, { workspaces: git.workspaces, clone: git.clone });
}
