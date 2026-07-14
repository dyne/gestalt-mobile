import { describe, expect, it } from 'vitest';

import { toPermissionApprovalResponse } from './permission-request.js';

describe('permission approval response', () => {
  it('returns the requested non-null profile for the current turn', () => {
    expect(
      toPermissionApprovalResponse({ permissions: { network: { enabled: true }, fileSystem: null } }),
    ).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
  });

  it('rejects malformed payloads', () => expect(toPermissionApprovalResponse({})).toBeNull());
});
