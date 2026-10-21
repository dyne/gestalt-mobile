/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import { readExecutorConfiguration } from './executor-configuration.js';
import { decodeCodexPolicyCatalog } from './codex-model-catalog.js';

const input = { rootThreadId: 'astra-root', threadId: 'luna-child', taskPath: '/root/l1_g2' };
const thread = () => ({
  id: input.threadId,
  parentThreadId: input.rootThreadId,
  source: { subAgent: { thread_spawn: { agent_path: input.taskPath } } },
  status: { type: 'idle' },
  model: 'gpt-6-luna',
  reasoningEffort: 'medium',
  agentRole: 'org-plan-executor',
});
const catalog = () => ({
  data: [
    {
      id: 'gpt-6-luna',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Not exported' }],
    },
  ],
  nextCursor: null,
});
const now = '2026-10-21T15:00:00Z';

describe('read-only child configuration adapter', () => {
  it('reads only the bound loaded child and existing catalog, without resume, turns or root-setting substitution', async () => {
    const request = vi.fn(async (method: string) =>
      method === 'thread/read' ? { thread: thread() } : catalog(),
    );
    const result = await readExecutorConfiguration(
      { request },
      input,
      () => true,
      () => now,
    );
    expect(request.mock.calls).toEqual([
      ['thread/read', { threadId: input.threadId, includeTurns: false }],
      ['model/list', {}],
    ]);
    expect(result).toMatchObject({
      kind: 'observed',
      configuration: {
        model: 'gpt-6-luna',
        reasoningEffort: 'medium',
        observedAt: now,
        settingsRevision: null,
        catalog: { source: 'runtime' },
      },
    });
    expect(JSON.stringify(result)).not.toContain('Not exported');
  });

  it.each([
    [{ reasoningEffort: null }, { reasoningEffort: null }],
    [{ reasoningEffort: undefined }, { reasoningEffort: null }],
    [{ model: null }, { model: null }],
    [{ model: undefined }, { model: null }],
  ])('does not infer missing settings %j', async (settings, expected) => {
    const request = vi.fn(async (method: string) =>
      method === 'thread/read' ? { thread: { ...thread(), ...settings } } : catalog(),
    );
    const result = await readExecutorConfiguration({ request }, input, () => true);
    expect(result).toMatchObject({
      kind: 'observed',
      configuration: expected,
    });
  });

  it.each([
    { id: 'other' },
    { parentThreadId: 'other-session' },
    { source: { subAgent: { thread_spawn: { agent_path: '/root/l1' } } } },
  ])('rejects mismatched runtime topology %j', async (settings) => {
    const request = vi.fn(async () => ({ thread: { ...thread(), ...settings } }));
    expect(await readExecutorConfiguration({ request }, input, () => true)).toEqual({
      kind: 'unavailable',
      code: 'CHILD_BINDING_MISMATCH',
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('labels an older protocol without direct parent metadata as unknown, not a proven mismatch', async () => {
    const request = vi.fn(async () => ({ thread: { ...thread(), parentThreadId: null } }));
    expect(await readExecutorConfiguration({ request }, input, () => true)).toEqual({
      kind: 'unavailable',
      code: 'CHILD_BINDING_UNKNOWN',
    });
  });

  it('never promotes persisted unloaded settings into current runtime evidence', async () => {
    const request = vi.fn(async () => ({ thread: { ...thread(), status: { type: 'notLoaded' } } }));
    expect(await readExecutorConfiguration({ request }, input, () => true)).toEqual({
      kind: 'unavailable',
      code: 'CHILD_NOT_LOADED',
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('discards an observation after an owning resource or settings notification changes', async () => {
    let current = true;
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: thread() };
      current = false;
      return catalog();
    });
    expect(await readExecutorConfiguration({ request }, input, () => current)).toEqual({
      kind: 'unavailable',
      code: 'OBSERVATION_CHANGED',
    });
  });

  it('preserves missing catalog support while retaining child settings', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: thread() };
      throw new Error('private error text');
    });
    expect(await readExecutorConfiguration({ request }, input, () => true)).toMatchObject({
      kind: 'observed',
      configuration: { model: 'gpt-6-luna', catalog: null },
    });
  });

  it('bounds an unavailable metadata read without leaving a timer or starting a model turn', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn(() => new Promise<unknown>(() => {}));
      const reading = readExecutorConfiguration(
        { request },
        input,
        () => true,
        () => now,
        50,
      );
      await vi.advanceTimersByTimeAsync(50);
      expect(await reading).toEqual({ kind: 'unavailable', code: 'RUNTIME_UNAVAILABLE' });
      expect(request).toHaveBeenCalledExactlyOnceWith('thread/read', {
        threadId: input.threadId,
        includeTurns: false,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runtime catalog policy projection', () => {
  it.each([
    {},
    { data: [] },
    { data: [{ id: 'gpt-6-luna' }] },
    { ...catalog(), nextCursor: 'more' },
    {
      data: [
        {
          id: 'gpt-6-luna',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'medium' }],
        },
      ],
    },
    { data: [...catalog().data, ...catalog().data] },
  ])('keeps incomplete or malformed catalog unknown: %j', (raw) => {
    expect(decodeCodexPolicyCatalog(raw)).toBeNull();
  });
  it('uses a deterministic content digest and preserves exact runtime effort support', () => {
    const raw = {
      models: [
        ...catalog().data,
        {
          id: 'gpt-6-sol',
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'medium' }],
        },
      ],
    };
    const first = decodeCodexPolicyCatalog(raw);
    const second = decodeCodexPolicyCatalog({ data: { models: [...raw.models].reverse() } });
    expect(first).toEqual(second);
    expect(first?.models[1]).toEqual({ id: 'gpt-6-sol', reasoningEfforts: ['high', 'medium'] });
    expect(decodeCodexPolicyCatalog({ data: catalog().data })?.revision).not.toBe(first?.revision);
  });
});
