/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import { observeOwningNative } from './owning-observation.js';
import { liveSourceDigest } from './owning-source-inventory.js';

function fixture() {
  return {
    configuration: {
      config: { model_providers: { controlled: { requires_openai_auth: false } } },
    },
    selection: {
      threadId: 'actual-thread',
      model: 'selected-model',
      modelProvider: 'controlled',
      cwd: '/project',
      approvalPolicy: 'never',
      activePermissionProfile: { id: 'named-profile', extends: null },
      sandbox: { type: 'readOnly', networkAccess: false },
      reasoningEffort: 'medium',
      runtimeWorkspaceRoots: ['/project', '/second'],
      instructionSources: ['/project/AGENTS.md'],
    },
    account: { account: null, requiresOpenaiAuth: false, workspaceRouting: null },
  };
}
it('binds only actual flags and credential-free account RPC identity without inventing optional fields', () => {
  const input = fixture();
  const observed = observeOwningNative(input);
  const flags = Object.fromEntries(
    Object.entries(input.selection).filter(([key]) => key !== 'threadId'),
  );
  expect(observed.sessionFlags).toEqual(flags);
  expect(observed.accountDigest).toBe(
    liveSourceDigest({ providerId: 'controlled', accountId: null }),
  );
  const reordered = {
    ...input,
    selection: { ...input.selection, runtimeWorkspaceRoots: ['/second', '/project'] },
  };
  expect(liveSourceDigest(observeOwningNative(reordered).sessionFlags)).not.toBe(
    liveSourceDigest(observed.sessionFlags),
  );
  const withoutOptional = Object.fromEntries(
    Object.entries(input.selection).filter(
      ([key]) => !['runtimeWorkspaceRoots', 'instructionSources'].includes(key),
    ),
  );
  expect(
    observeOwningNative({ ...input, selection: withoutOptional }).sessionFlags,
  ).not.toHaveProperty('instructionSources');
  input.selection.model = 'later';
  expect(observed.sessionFlags.model).toBe('selected-model');
});
it('binds a recognized actual ChatGPT account profile opaquely and detects identity changes', () => {
  const input = fixture();
  const account = { type: 'chatgpt', email: 'first@example.invalid', planType: 'plus' };
  const observed = observeOwningNative({
    ...input,
    account: { account, requiresOpenaiAuth: true },
  });
  expect(JSON.stringify(observed).includes(account.email)).toBe(false);
  expect(observed.accountDigest).toBe(
    liveSourceDigest({ providerId: 'controlled', accountId: account }),
  );
  const changed = observeOwningNative({
    ...input,
    account: { account: { ...account, email: 'second@example.invalid' }, requiresOpenaiAuth: true },
  });
  expect(changed.accountDigest).not.toBe(observed.accountDigest);
});
it.each([
  {},
  { account: null, requiresOpenaiAuth: true },
  { account: null, requiresOpenaiAuth: false, credential: 'forbidden' },
  { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
  {
    account: { type: 'amazonBedrock', usesCodexManagedCredentials: true },
    requiresOpenaiAuth: false,
  },
  { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true },
  {
    account: { type: 'chatgpt', email: 'fixture', planType: 'unrecognized' },
    requiresOpenaiAuth: true,
  },
])(
  'refuses unknown or unidentifiable account semantics without credential-derived identity %#',
  (account) => {
    expect(() => observeOwningNative({ ...fixture(), account })).toThrow(
      'LIVE_OWNING_OBSERVATION_UNVERIFIED',
    );
  },
);
it('requires explicit selected-provider no-auth semantics and complete actual flags', () => {
  const input = fixture();
  expect(() => observeOwningNative({ ...input, configuration: { config: {} } })).toThrow(
    'LIVE_OWNING_OBSERVATION_UNVERIFIED',
  );
  const missing = Object.fromEntries(
    Object.entries(input.selection).filter(([key]) => key !== 'sandbox'),
  );
  expect(() => observeOwningNative({ ...input, selection: missing })).toThrow(
    'LIVE_OWNING_OBSERVATION_UNVERIFIED',
  );
  expect(() =>
    observeOwningNative({ ...input, selection: { ...input.selection, unknownAuthority: true } }),
  ).toThrow('LIVE_OWNING_OBSERVATION_UNVERIFIED');
});
