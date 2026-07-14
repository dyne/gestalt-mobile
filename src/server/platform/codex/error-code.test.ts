import { describe, expect, it } from 'vitest';
import { protocolErrorCode } from './error-code.js';
describe('protocolErrorCode', () => {
  it('uses a stable missing-Codex code', () =>
    expect(protocolErrorCode(null, 'v')).toBe('CODEX_NOT_FOUND'));
});
