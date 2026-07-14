import { describe, expect, it } from 'vitest';

import { toPendingInteraction } from './server-request.js';

describe('Codex server request mapping', () => {
  it('maps a command approval to the relay interaction vocabulary', () => {
    expect(
      toPendingInteraction({
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'git status' },
      }),
    ).toEqual({ requestId: '7', kind: 'commandApproval', payload: { command: 'git status' } });
  });
});
