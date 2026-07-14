import { describe, expect, it } from 'vitest';
import { problem } from './problem.js';
describe('problem', () => {
  it('creates stable problem documents', () =>
    expect(problem('SESSION_NOT_FOUND', 404, 'Missing')).toMatchObject({
      code: 'SESSION_NOT_FOUND',
      status: 404,
      retryable: false,
    }));
});
