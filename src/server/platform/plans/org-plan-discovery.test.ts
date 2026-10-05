/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { OrgPlanDiscovery } from './org-plan-discovery.js';

describe('OrgPlanDiscovery', () => {
  it('uses bfs with shell-free arguments and preserves spaces and newlines in paths', async () => {
    const execute = vi.fn(
      async () => './one/.gestalt/space name.org\0./two/.gestalt/line\nbreak.org\0',
    );
    expect(await new OrgPlanDiscovery(execute).list('/workspace root')).toEqual([
      'one/.gestalt/space name.org',
      'two/.gestalt/line\nbreak.org',
    ]);
    expect(execute).toHaveBeenCalledWith(
      'bfs',
      ['.', '-type', 'f', '-name', '*.org', '-path', '*/.gestalt/*', '-print0'],
      '/workspace root',
    );
  });

  it('falls back to find once when bfs is absent', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'bfs') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return './.gestalt/plan.org\0';
    });
    const discovery = new OrgPlanDiscovery(execute);
    await expect(discovery.list('/root')).resolves.toEqual(['.gestalt/plan.org']);
    await discovery.list('/root');
    expect(execute.mock.calls.map(([command]) => command)).toEqual(['bfs', 'find', 'find']);
  });

  it('propagates traversal failure instead of treating it as an empty catalog', async () => {
    const execute = vi.fn(async () => {
      throw new Error('timeout');
    });
    await expect(new OrgPlanDiscovery(execute).list('/root')).rejects.toThrow('timeout');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
