import { describe, expect, it } from 'vitest';
import { requireThreadId } from './thread-id.js';
describe('requireThreadId', () => {
  it('rejects absent SSH-resumable threads', () =>
    expect(() => requireThreadId(null)).toThrow('THREAD_REQUIRED'));
});
