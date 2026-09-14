/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */

import { cleanup, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotificationHistory from './NotificationHistory.svelte';
import { createToastQueue } from './toast-queue.js';

afterEach(cleanup);

describe('NotificationHistory', () => {
  it('shows an empty state and returns through its named Back action', async () => {
    const onclose = vi.fn();
    render(NotificationHistory, { queue: createToastQueue(), onclose });

    expect(screen.getByRole('status').textContent).toBe('No recent notifications.');
    screen.getByRole('button', { name: 'Back' }).click();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('lists recent notifications newest first after viewport dismissal', () => {
    const queue = createToastQueue({ now: () => Date.parse('2026-09-14T10:00:00Z') });
    const warning = queue.enqueue({ kind: 'warning', message: 'Recovering prompt.' });
    queue.dismiss(warning);
    queue.enqueue({ kind: 'success', message: 'Repository cloned.' });
    render(NotificationHistory, { queue, onclose: () => {} });

    const history = screen.getByRole('list', { name: 'Recent notifications' });
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Repository cloned.');
    expect(items[1]?.textContent).toContain('Recovering prompt.');
  });
});
