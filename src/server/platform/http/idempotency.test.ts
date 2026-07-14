import { describe, expect, it } from 'vitest';
import { idempotencyKey } from './idempotency.js';
describe('idempotencyKey', () => {
  it('requires a nonblank header', () => {
    expect(idempotencyKey({ 'idempotency-key': ' k ' })).toBe(' k ');
    expect(idempotencyKey({})).toBeNull();
  });
});
