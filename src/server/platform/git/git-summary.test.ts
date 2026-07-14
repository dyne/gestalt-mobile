import { describe, expect, it } from 'vitest';
import { toGitSummary } from './git-summary.js';
describe('toGitSummary', () => {
  it('cannot push without an upstream', () =>
    expect(toGitSummary({ branch: 'main', upstream: null, ahead: 1, behind: 0 }).canPush).toBe(
      false,
    ));
});
