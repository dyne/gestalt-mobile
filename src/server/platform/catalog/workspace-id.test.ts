import { describe, expect, it } from 'vitest';
import { workspaceId } from './workspace-id.js';
describe('workspaceId', () => {
  it('does not expose workspace paths in IDs', () =>
    expect(workspaceId('/private/project')).not.toContain('private'));
});
