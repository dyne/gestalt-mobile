/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* @vitest-environment jsdom */
import { cleanup, render, screen, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ToolEfficiencyDetails from './ToolEfficiencyDetails.svelte';
import { efficiencyFixture } from '../../../shared/contracts/tool-efficiency.test-fixture.js';

afterEach(cleanup);
describe('ToolEfficiencyDetails', () => {
  it('uses a native disclosure and distinguishes zero, unknown, partial coverage and actor/wrapper scopes', async () => {
    const { container } = render(ToolEfficiencyDetails, {
      sessionId: 'session',
      snapshot: efficiencyFixture(),
    });
    const summary = container.querySelector('summary')!;
    await fireEvent.click(summary);
    expect(summary.textContent).toContain('Partial coverage');
    expect(screen.getByText('0 ms')).toBeTruthy();
    expect(screen.getByText('0 B')).toBeTruthy();
    expect(screen.getByText('Root (l0) · Commands')).toBeTruthy();
    expect(screen.getByText('Root (l0) · Execution wrappers')).toBeTruthy();
    expect(
      screen.getByText('Child (child-thread-with-a-long-opaque-identity) · Context-mode'),
    ).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1 of 2 calls measured · partial').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Some events could not be attributed');
    expect(container.textContent).toContain('Observation retention is limited');
    expect(container.textContent).toContain('Serialized MCP content');
    expect(container.textContent).toContain('Command output, UTF-8');
    expect(container.textContent).toContain('Wrapper scope');
    expect(container.textContent).toContain('Retries');
    expect(container.textContent).toContain('Reused calls');
    expect(container.textContent).toContain('1 partial');
    expect(container.textContent).not.toMatch(/score|quota|saved|grep violation/i);
    expect(screen.getByRole('region', { name: 'Tool efficiency observations' }).tabIndex).toBe(0);
  });
  it('shows a useful empty state and hides metrics belonging to another session', async () => {
    const view = render(ToolEfficiencyDetails, { sessionId: 'empty' });
    expect(screen.getByText('No measurements yet')).toBeTruthy();
    expect(screen.getByText(/No measured tool calls yet/)).toBeTruthy();
    await view.rerender({ sessionId: 'empty', snapshot: efficiencyFixture('other') });
    expect(view.container.textContent).not.toContain('Root (l0)');
    expect(view.container.textContent).not.toContain('4,096');
  });
});
