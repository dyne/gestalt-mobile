import { describe, expect, it } from 'vitest';
import { profileAppServerArgs } from './profile-command.js';
describe('profileAppServerArgs', () => {
  it('uses codex-profile app-server stdio semantics', () =>
    expect(profileAppServerArgs('default')).toEqual(['cli', 'default', 'app-server', '--stdio']));
});
