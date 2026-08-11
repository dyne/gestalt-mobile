/* Copyright (C) 2026 Dyne.org foundation SPDX-License-Identifier: AGPL-3.0-or-later */
import { expect, it } from 'vitest';
import { serializeChatCache } from './chat-cache.js';
import { createChatProjection, failInteraction, hydrateCache } from './chat-projection.js';
it('redacts assistant output, arbitrary interaction payloads, and secret retry values', () => {
  const projection = failInteraction(
    {
      ...createChatProjection('s'),
      messages: [{ id: 'a', role: 'assistant', text: 'model output', complete: true }],
      interactions: [
        {
          requestId: 'r',
          key: 'r',
          kind: 'quiz',
          payload: { secret: 'no' },
          state: 'submitting',
          operationId: 'k',
        },
      ],
    },
    'r',
    { secret: 'no' },
  );
  const cached = JSON.stringify(serializeChatCache(projection));
  expect(cached).not.toContain('model output');
  expect(cached).not.toContain('secret');
  expect(cached).not.toContain('no');
});
it('keeps only safe approval decision shape through reload', () => {
  const projection = failInteraction(
    {
      ...createChatProjection('s'),
      interactions: [
        {
          requestId: 'r',
          key: 'r',
          kind: 'commandApproval',
          payload: {},
          state: 'submitting',
          operationId: 'k',
        },
      ],
    },
    'r',
    { decision: 'accept' },
  );
  expect(hydrateCache('s', serializeChatCache(projection)).interactions[0]).toMatchObject({
    operationId: 'k',
    attemptedOutcome: { decision: 'accept' },
  });
});
it('normalizes malformed cached lifecycle and active turn', () => {
  const hydrated = hydrateCache('s', {
    cursor: 0,
    lifecycle: 'evil',
    activeTurnId: 7,
    messages: [],
    prompts: [],
    interactions: [],
  });
  expect(hydrated).toMatchObject({ lifecycle: 'finished', activeTurnId: null });
});
it('redacts quiz answers so reload requires re-entry', () => {
  const projection = failInteraction(
    {
      ...createChatProjection('s'),
      interactions: [
        {
          requestId: 'q',
          key: 'q',
          kind: 'quiz',
          payload: {},
          state: 'submitting',
          operationId: 'key',
        },
      ],
    },
    'q',
    { answer: 'secret' },
  );
  const json = JSON.stringify(serializeChatCache(projection));
  expect(json).not.toContain('secret');
  expect(
    hydrateCache('s', serializeChatCache(projection)).interactions[0]?.attemptedOutcome,
  ).toBeUndefined();
});
