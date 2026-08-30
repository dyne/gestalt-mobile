/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { presentActivity, summarizeCommandActivities } from './activity-presentation.js';

describe('activity presentation', () => {
  it('shows the command content without the bash wrapper and keeps its status separate', () => {
    expect(
      presentActivity({
        id: 'command',
        label: 'Command · in_progress',
        detail: '/bin/bash -lc "git status --short"',
      }),
    ).toEqual({ kind: 'Command', status: 'in_progress', content: 'git status --short' });
  });

  it('keeps file paths beside their compact action type', () => {
    expect(
      presentActivity({
        id: 'files',
        label: 'File change · completed',
        detail: 'src/app.ts\nsrc/routes.ts',
      }),
    ).toEqual({ kind: 'File change', status: 'completed', content: 'src/app.ts, src/routes.ts' });
  });

  it('hides context-mode tool calls when only the tool name is available', () => {
    expect(
      presentActivity({
        id: 'ctx',
        label: 'Tool · completed',
        detail: 'mcp__context_mode__ctx_execute',
      }),
    ).toBeNull();
  });

  it('retains other tool calls', () => {
    expect(
      presentActivity({ id: 'tool', label: 'Tool · completed', detail: 'functions.exec' }),
    ).toEqual({ kind: 'Tool', status: 'completed', content: 'functions.exec' });
  });
});

describe('command activity summary', () => {
  it('counts completed and failed commands without counting pending or declined commands', () => {
    expect(
      summarizeCommandActivities([
        { id: 'one', label: 'Command · completed', detail: 'npm test' },
        { id: 'two', label: 'Command · completed', detail: 'npm run build' },
        { id: 'three', label: 'Command · failed', detail: 'npm run lint' },
        { id: 'four', label: 'Command · inProgress', detail: 'npm install' },
        { id: 'five', label: 'Command · declined', detail: 'git push' },
        { id: 'tool', label: 'Tool · failed', detail: 'lookup' },
      ]),
    ).toEqual({ successful: 2, failed: 1 });
  });
});
