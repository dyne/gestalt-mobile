/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type LiveTarget = { appId: string; targetId: string };
export type LiveRun = {
  liveId: string;
  generation: number;
  state?: string;
};
export type LiveGrant = {
  grantId: string;
  grant: string;
  previewOrigin: string;
};
export type LiveClient = {
  liveTargets(id: string): Promise<{ targets: LiveTarget[] }>;
  liveStatus(id: string): Promise<LiveRun>;
  liveStart(id: string, input: LiveTarget & { operationId: string }): Promise<LiveRun>;
  liveLaunch(id: string, input: LiveRun & { codeChallenge: string }): Promise<LiveGrant>;
};
