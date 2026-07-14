import { describe, expect, it } from 'vitest';
import { validateStartForm } from './start-form.js';
describe('validateStartForm', () => {
  it('requires workspace and profile selections', () =>
    expect(validateStartForm({ workspaceId: '', profile: '' })).toEqual({
      workspaceId: 'Choose a workspace.',
      profile: 'Choose a profile.',
    }));
});
