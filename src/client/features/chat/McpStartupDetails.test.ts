/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import McpStartupDetails from './McpStartupDetails.svelte';
import ActivityList from './ActivityList.svelte';
import WorkDetails from './WorkDetails.svelte';
import {
  mcpStartupActivity,
  parseMcpStartupStatus,
} from '../../../shared/contracts/mcp-startup-failure.js';

const failure = (serverName = 'context-mode') =>
  parseMcpStartupStatus({
    schemaVersion: 1,
    runtimeId: 'runtime',
    attemptId: 'attempt',
    threadId: 'child',
    serverName,
    observedAt: '2026-10-26T18:00:00.000Z',
    status: 'failed',
    failure: {
      schemaVersion: 1,
      runtimeId: 'runtime',
      attemptId: 'attempt',
      failureId: 'safe-trace-reference',
      threadId: 'child',
      serverName,
      occurredAt: '2026-10-26T18:00:00.000Z',
      phase: 'startup',
      code: 'startup-failed',
    },
  })!;

describe('MCP startup presentation', () => {
  afterEach(cleanup);
  it('shows required failure, observed phase, unknown diagnostics and an accessible trace disclosure', async () => {
    render(McpStartupDetails, { startup: failure() });
    expect(screen.getByRole('region', { name: 'Context Mode startup' })).toBeTruthy();
    expect(screen.getByText(/Required tool unavailable/)).toBeTruthy();
    expect(screen.getByText('startup')).toBeTruthy();
    expect(screen.getByText(/No underlying cause is established/)).toBeTruthy();
    expect(screen.getByText('Codex did not expose child exit or signal details.')).toBeTruthy();
    const reference = screen.getByText('Trace reference');
    await fireEvent.click(reference);
    expect(reference.closest('details')?.open).toBe(true);
    expect(screen.getByText('safe-trace-reference')).toBeTruthy();
    expect(screen.getByText('2026-10-26T18:00:00.000Z')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(['gestalt-serena', 'gestalt-xerj'])(
    'preserves optional %s fallback and explains recovery',
    async (server) => {
      const startup = failure(server);
      const view = render(McpStartupDetails, { startup });
      expect(screen.getByText(/Optional .*unavailable/)).toBeTruthy();
      await view.rerender({ startup: { ...startup, status: 'ready', failure: null } });
      expect(screen.queryByText(/Optional .*unavailable/)).toBeNull();
      expect(
        screen.getByText(/startup failures remain in the session trace and notification history/),
      ).toBeTruthy();
      expect(screen.getByText(/does not establish repository or language readiness/)).toBeTruthy();
    },
  );

  it.each([ActivityList, WorkDetails])(
    'renders the structured failure in an existing activity surface',
    (component) => {
      render(component, { activities: [mcpStartupActivity(failure())] });
      expect(screen.getByRole('region', { name: 'Context Mode startup' })).toBeTruthy();
      expect(screen.getByText(/Codex reported a startup failure/)).toBeTruthy();
    },
  );
});
