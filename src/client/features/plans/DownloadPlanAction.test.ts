/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import DownloadPlanAction from './DownloadPlanAction.svelte';

afterEach(cleanup);
const reference = { kind: 'workspace' as const, workspaceId: 'w', planName: '.gestalt/plan.org' };

it('prevents duplicate downloads while pending and reports failures through the shared callback', async () => {
  const pending = Promise.withResolvers<{ filename: string; blob: Blob }>();
  const downloadOrgPlan = vi.fn<
    (reference: unknown, signal?: AbortSignal) => typeof pending.promise
  >(() => pending.promise);
  const onerror = vi.fn();
  render(DownloadPlanAction, { reference, transport: { downloadOrgPlan }, onerror });
  const button = screen.getByRole('button', { name: 'Download Org file' });
  await fireEvent.click(button);
  await fireEvent.click(button);
  expect(downloadOrgPlan).toHaveBeenCalledExactlyOnceWith(reference, expect.any(AbortSignal));
  expect(button).toHaveProperty('disabled', true);
  expect(button.textContent).toContain('Downloading…');
  pending.reject(new Error('unavailable'));
  await waitFor(() =>
    expect(onerror).toHaveBeenCalledWith('Could not download the Org file. Try again.'),
  );
  expect(button).toHaveProperty('disabled', false);
});

it('aborts a pending download when the view closes without reporting an operation error', async () => {
  const pending = Promise.withResolvers<{ filename: string; blob: Blob }>();
  const downloadOrgPlan = vi.fn<
    (reference: unknown, signal?: AbortSignal) => typeof pending.promise
  >(() => pending.promise);
  const onerror = vi.fn();
  const view = render(DownloadPlanAction, { reference, transport: { downloadOrgPlan }, onerror });
  await fireEvent.click(screen.getByRole('button', { name: 'Download Org file' }));
  const signal = downloadOrgPlan.mock.calls[0]![1] as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  pending.reject(new DOMException('aborted', 'AbortError'));
  await pending.promise.catch(() => undefined);
  await tick();
  expect(onerror).not.toHaveBeenCalled();
});
