import { describe, expect, it } from 'vitest';
import { mayPush } from './push-policy.js';
describe('mayPush', () => {
  it('prevents push while behind upstream', () =>
    expect(mayPush({ upstream: 'origin/main', ahead: 1, behind: 1 })).toEqual({
      allowed: false,
      reason: 'BEHIND_UPSTREAM',
    }));
});
