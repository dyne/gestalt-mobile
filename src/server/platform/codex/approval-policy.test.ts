import { describe, expect, it } from 'vitest';
import { requiresApproval } from './approval-policy.js';
describe('requiresApproval', () => {
  it('preserves user approval requests unless policy is never', () => {
    expect(requiresApproval('on-request', true)).toBe(true);
    expect(requiresApproval('never', true)).toBe(false);
  });
});
