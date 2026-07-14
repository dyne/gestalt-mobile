import { describe, expect, it } from 'vitest';
import { profileAppServerCommand } from './profile-command.js';
describe('profileAppServerArgs', () => {
  it('uses direct Codex app-server semantics for the default home', () =>
    expect(profileAppServerCommand('default')).toEqual({
      command: 'codex',
      args: ['app-server', '--stdio'],
    }));

  it('uses codex-profile for a managed profile', () =>
    expect(profileAppServerCommand('work')).toEqual({
      command: 'codex-profile',
      args: ['cli', 'work', 'app-server', '--stdio'],
    }));
});
