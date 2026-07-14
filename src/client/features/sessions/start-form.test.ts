import { describe, expect, it } from 'vitest';
import { validateStartForm } from './start-form.js';
describe('validateStartForm', () => {
  it('requires workspace and profile selections', () =>
    expect(validateStartForm({ workspaceId: '', profile: '' })).toEqual({
      workspaceId: 'Choose a workspace.',
      profile: 'Choose a profile.',
    }));

  it('rejects a profile that is not ready to start Codex', () =>
    expect(
      validateStartForm({
        workspaceId: 'workspace',
        profile: 'offline',
        profileState: 'not_logged_in',
      }),
    ).toEqual({ profile: 'Sign in to this profile before starting Codex.' }));
});
