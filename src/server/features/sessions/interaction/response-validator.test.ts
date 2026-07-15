import { describe, expect, it } from 'vitest';

import { isValidInteractionResponse } from './response-validator.js';

describe('isValidInteractionResponse', () => {
  it('requires generated user-input answer arrays', () => {
    expect(
      isValidInteractionResponse('userInput', {
        answers: { workspace: { answers: ['continue'] } },
      }),
    ).toBe(true);
    expect(isValidInteractionResponse('userInput', { answers: { workspace: {} } })).toBe(false);
    expect(
      isValidInteractionResponse('userInput', { answers: { workspace: { answers: [1] } } }),
    ).toBe(false);
  });

  it('limits approval decisions to each generated approval response shape', () => {
    expect(isValidInteractionResponse('commandApproval', { decision: 'accept' })).toBe(true);
    expect(
      isValidInteractionResponse('commandApproval', {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: {} } },
      }),
    ).toBe(true);
    expect(
      isValidInteractionResponse('fileChangeApproval', {
        decision: 'acceptWithExecpolicyAmendment',
      }),
    ).toBe(false);
    expect(
      isValidInteractionResponse('permissionsApproval', { permissions: {}, scope: 'session' }),
    ).toBe(true);
  });
});
