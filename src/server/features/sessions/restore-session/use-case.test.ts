/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { CodexJsonRpcError } from '../../../platform/codex/json-rpc-client.js';
import type { RelaySessionSnapshot } from '../model/relay-session.js';
import { canRebindMissingRollout, canRestore, rebindMissingRollout } from './use-case.js';
describe('canRestore', () => {
  it('requires a persisted thread and no active turn', () => {
    expect(canRestore({ threadId: null, state: 'ready' } as never)).toBe(false);
    expect(canRestore({ threadId: 't', state: 'turnActive' } as never)).toBe(false);
  });

  it('rejects an already relay-owned ready session', () => {
    expect(canRestore({ threadId: 't', state: 'ready' } as never)).toBe(false);
  });

  it('allows an inactive persisted session to be reclaimed', () => {
    expect(canRestore({ threadId: 't', state: 'released' } as never)).toBe(true);
    expect(canRestore({ threadId: 't', state: 'stopped' } as never)).toBe(true);
  });

  it('allows replacement only for a missing rollout from a permitted source state', () => {
    const missing = new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread');
    expect(canRebindMissingRollout({ threadId: 'old-thread', state: 'stopped' } as never, missing)).toBe(true);
    expect(canRebindMissingRollout({ threadId: 'old-thread', state: 'released' } as never, missing)).toBe(true);
    expect(canRebindMissingRollout({ threadId: 'old-thread', state: 'attentionRequired' } as never, missing)).toBe(true);
    expect(canRebindMissingRollout({ threadId: 'old-thread', state: 'ready' } as never, missing)).toBe(false);
    expect(
      canRebindMissingRollout(
        { threadId: 'old-thread', state: 'released' } as never,
        new CodexJsonRpcError(-32600, 'invalid parameters'),
      ),
    ).toBe(false);
  });

  it('rebinds a replacement without changing durable relay identity or metadata', () => {
    const original: RelaySessionSnapshot = {
      id: 'session-1', workspaceId: 'workspace-1', workspacePath: '/workspace', profile: 'default',
      model: 'gpt-5', branch: 'main', threadId: 'old-thread', state: 'released', desiredState: 'stopped',
      activeTurnId: null, protocolVersion: null, failureCount: 2, pendingInteractions: [],
      effectiveSkillSelection: { selectedProfileName: 'focused', skills: [] },
      lastOrgPlan: { filename: 'plan.org', title: 'Plan' }, createdAt: 'before', updatedAt: 'before',
    };
    const recovered = rebindMissingRollout(
      original,
      new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread'),
      'replacement-thread',
      'after',
    );
    expect(recovered).toMatchObject({ historyUnavailable: true, replacementCreated: true });
    expect(recovered.session).toMatchObject({ ...original, threadId: 'replacement-thread', state: 'ready', updatedAt: 'after' });
  });

  it('does not create a replacement when the response is unrelated or malformed', () => {
    const original = { threadId: 'old-thread', state: 'attentionRequired' as const };
    expect(() => rebindMissingRollout(original as never, new CodexJsonRpcError(-32600, 'invalid parameters'), 'new-thread', 'after')).toThrow('CODEX_ROLLOUT_REBIND_NOT_ALLOWED');
    expect(() => rebindMissingRollout(original as never, new CodexJsonRpcError(-32600, 'no rollout found for thread id old-thread'), '', 'after')).toThrow('INVALID_SESSION_VALUE');
    expect(original.threadId).toBe('old-thread');
  });
});
