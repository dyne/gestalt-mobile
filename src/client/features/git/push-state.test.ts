import { describe, expect, it } from 'vitest';
import { pushState } from './push-state.js';
describe('pushState', () => {
  it('explains unavailable Push without upstream', () =>
    expect(pushState({ upstream: null, ahead: 2 })).toEqual({
      enabled: false,
      reason: 'No upstream branch is configured.',
    }));
});
