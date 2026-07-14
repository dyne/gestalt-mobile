import { describe, expect, it } from 'vitest';
import { formatSessions } from './list-sessions.js';
describe('formatSessions', () => {
  it('handles no persisted sessions', () => expect(formatSessions([])).toBe('No sessions\n'));
});
