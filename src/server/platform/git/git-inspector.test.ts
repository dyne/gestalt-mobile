import { describe, expect, it } from 'vitest';

import { parseDivergence } from './git-inspector.js';

describe('git inspector', () => {
  it('parses git left-right divergence counts', () => {
    expect(parseDivergence('3\t2\n')).toEqual({ ahead: 3, behind: 2 });
  });
});
