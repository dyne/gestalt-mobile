import { describe, expect, it } from 'vitest';

import { parseDivergence, parseDirtyCounts } from './git-inspector.js';

describe('git inspector', () => {
  it('parses git left-right divergence counts', () => {
    expect(parseDivergence('3\t2\n')).toEqual({ ahead: 3, behind: 2 });
  });
  it('counts staged, unstaged, and untracked porcelain entries', () => {
    expect(parseDirtyCounts('M  staged.ts\n M unstaged.ts\n?? new.ts\n')).toEqual({
      staged: 1,
      unstaged: 1,
      untracked: 1,
    });
  });
});
