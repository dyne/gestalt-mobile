import { describe, expect, it } from 'vitest';

import { createIdempotencyKey } from './idempotency-key.js';

describe('idempotency key', () => {
  it('uses randomUUID when the browser provides it', () => {
    expect(createIdempotencyKey({ randomUUID: () => 'uuid-1' })).toBe('uuid-1');
  });

  it('falls back when randomUUID is unavailable on plain HTTP', () => {
    expect(
      createIdempotencyKey(
        {},
        () => 1234,
        () => 0.5,
      ),
    ).toBe('k-ya-zik0zk');
  });
});
