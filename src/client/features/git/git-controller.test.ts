/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { GitController, type GitState } from './git-controller.js';

const summary = { available: true, branch: 'main', upstream: null, ahead: 0, behind: 0, dirty: { staged: 0, unstaged: 0, untracked: 0 }, commits: [], fetchedAt: null };

describe('GitController', () => {
  it('ignores a stale summary after selecting another workspace', async () => {
    const resolves: Array<(value: typeof summary) => void> = [];
    const states: GitState[] = [];
    const controller = new GitController({ getSummary: vi.fn(() => new Promise<typeof summary>((done) => { resolves.push(done); })), pull: vi.fn(async () => undefined), checkout: vi.fn(async () => undefined) }, () => true, (state) => states.push(state), () => 'failed');
    controller.select('one');
    controller.select('two');
    resolves[0]?.(summary);
    await Promise.resolve();
    expect(states.at(-1)?.workspaceId).toBe('two');
    expect(states.at(-1)?.summary).toBeNull();
  });
});
