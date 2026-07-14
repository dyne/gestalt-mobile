import { describe, expect, it } from 'vitest';
import { listSessions } from './use-case.js';
describe('listSessions', () => {
  it('shows most recently updated sessions first', () =>
    expect(
      listSessions([{ updatedAt: 'a' }, { updatedAt: 'b' }] as never).map(
        (session) => session.updatedAt,
      ),
    ).toEqual(['b', 'a']));
});
