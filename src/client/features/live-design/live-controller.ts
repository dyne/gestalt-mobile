/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LiveClient, LiveRun, LiveTarget } from './contracts.js';

export type LiveView = {
  targets: LiveTarget[];
  selection: number;
  run: LiveRun | null;
  pending: boolean;
  checking: boolean;
  uncertainStart: boolean;
  guidance: string;
};
const setup =
  'Live needs a registered app, the managed runtime, and an operator-configured HTTPS preview with Caddy. Ask the operator to check Live setup.';
const messages: Record<string, string> = {
  LIVE_SESSION_BUSY: 'This session is busy. Wait for its current work to finish, then retry Start.',
  LIVE_MODE_ACTIVE: 'Live already controls this session. Refresh its status before continuing.',
  LIVE_APP_BUSY: 'Another Live session controls this app. Stop that session before starting here.',
  LIVE_PROVIDER_UNSUPPORTED:
    'Live is available for Codex sessions. This session can continue in chat.',
  LIVE_CONFIG_CHANGED: 'Live setup changed. Refresh its status and use recovery controls.',
};

export class LiveController {
  view: LiveView = {
    targets: [],
    selection: 0,
    run: null,
    pending: false,
    checking: true,
    uncertainStart: false,
    guidance: 'Checking Live availability…',
  };
  private revision = 0;
  private disposed = false;
  private operation: (LiveTarget & { operationId: string }) | null = null;

  constructor(
    private readonly client: LiveClient,
    private readonly relayId: string,
    private readonly publish: (view: LiveView) => void,
    private readonly notify: (message: string) => void,
  ) {}

  private update(patch: Partial<LiveView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.publish(this.view);
  }

  dispose(): void {
    this.disposed = true;
    this.revision++;
  }

  select(selection: number): void {
    if (this.view.pending || this.operation) return;
    this.update({ selection });
  }

  async refresh(reportFailure = false): Promise<void> {
    if (this.view.pending) return;
    const revision = ++this.revision;
    const [targets, status] = await Promise.allSettled([
      this.client.liveTargets(this.relayId),
      this.client.liveStatus(this.relayId),
    ]);
    if (this.disposed || revision !== this.revision) return;
    const run = status.status === 'fulfilled' ? status.value : this.view.run;
    const acquired = run && !['idle', 'stopped'].includes(run.state ?? '');
    if (acquired) this.operation = null;
    const available = targets.status === 'fulfilled' ? targets.value.targets : [];
    this.update({
      targets: available,
      run,
      checking: false,
      uncertainStart: acquired ? false : this.view.uncertainStart,
      guidance: acquired
        ? 'Live controls this session. Open the preview to design your app.'
        : available.length
          ? 'Live controls this session while you design. Choose an app to start.'
          : setup,
    });
    if (reportFailure && targets.status === 'rejected') this.notify(setup);
  }

  async start(): Promise<void> {
    if (
      this.view.pending ||
      this.view.checking ||
      (this.view.run && !['idle', 'stopped'].includes(this.view.run.state ?? ''))
    )
      return;
    const target = this.view.targets[this.view.selection];
    if (!target) return;
    this.operation ??= { ...target, operationId: crypto.randomUUID() };
    const revision = ++this.revision;
    this.update({ pending: true, guidance: 'Starting Live… Preparing your app and preview.' });
    try {
      // An uncertain request keeps the same acquisition identity; reconcile before retrying.
      let existing: LiveRun | null = null;
      try {
        existing = await this.client.liveStatus(this.relayId);
      } catch (error) {
        if ((error as { code?: string }).code !== 'LIVE_NOT_FOUND') throw error;
      }
      const run =
        existing && !['idle', 'stopped'].includes(existing.state ?? '')
          ? existing
          : await this.client.liveStart(this.relayId, this.operation);
      if (this.disposed || revision !== this.revision) return;
      this.operation = null;
      this.update({
        run,
        pending: false,
        uncertainStart: false,
        guidance: 'Live controls this session. Open the preview to design your app.',
      });
    } catch (error) {
      if (this.disposed || revision !== this.revision) return;
      const code = (error as { code?: string }).code ?? '';
      const definitive = !!code && code !== 'LIVE_START_FAILED';
      const message =
        messages[code] ??
        (definitive
          ? 'Live could not start. Ask the operator to check Live setup, then retry Start.'
          : 'Start may still be completing. Keep this app selected and retry Start to check safely.');
      if (definitive) this.operation = null;
      this.update({ pending: false, uncertainStart: !definitive, guidance: message });
      this.notify(message);
    }
  }
}
