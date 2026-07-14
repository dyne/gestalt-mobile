import { describe, expect, it } from 'vitest';

import { toActivity } from './activity-summary.js';

describe('history activity summary', () => {
  it('renders command metadata without command output', () => {
    expect(
      toActivity({ id: 'c', kind: 'command', command: 'git status', status: 'completed' }),
    ).toEqual({
      id: 'c',
      label: 'Command · completed',
      detail: 'git status',
    });
  });
});
