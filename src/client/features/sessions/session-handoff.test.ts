/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';
import {
  handoffSession,
  SessionPresentation,
  type SessionHandoffPorts,
} from './session-handoff.js';
import type { RelaySession } from './relay-client.js';

const session: RelaySession = {
  id: 'ordinary',
  state: 'turnActive',
  provider: 'codex',
  model: 'saved-model',
  effectiveSkillSelection: {
    selectedProfileName: 'supervisor',
    skills: [],
    warnings: ['Missing optional skill'],
  },
};
const draft = { text: 'Retained draft', revision: 7, pending: [] };
function fixture() {
  return {
    publish: vi.fn(),
    warn: vi.fn(),
    select: vi.fn(),
    saveSelectedSession: vi.fn().mockResolvedValue(undefined),
    refreshRoster: vi.fn().mockResolvedValue(undefined),
    readDraft: vi.fn().mockResolvedValue(draft),
    restoreDraft: vi.fn(),
  } satisfies SessionHandoffPorts;
}

describe('ordinary session handoff', () => {
  it.each(['empty', 'load'] as const)(
    'shares selection/cache/draft/activity ownership with %s history mode',
    async (history) => {
      const ports = fixture();
      const present = vi.fn();
      expect(
        await handoffSession(session, ports, { history, isCurrent: () => true, present }),
      ).toBe(true);
      expect(ports.publish).toHaveBeenCalledExactlyOnceWith(session);
      expect(ports.warn).toHaveBeenCalledExactlyOnceWith('Missing optional skill');
      expect(ports.select).toHaveBeenCalledExactlyOnceWith(session, history);
      expect(ports.saveSelectedSession).toHaveBeenCalledExactlyOnceWith('ordinary');
      expect(ports.refreshRoster).toHaveBeenCalledOnce();
      expect(ports.readDraft).toHaveBeenCalledExactlyOnceWith('ordinary');
      expect(ports.restoreDraft).toHaveBeenCalledExactlyOnceWith('ordinary', draft);
      expect(present).toHaveBeenCalledOnce();
      expect(ports.select.mock.invocationCallOrder[0]).toBeLessThan(
        ports.readDraft.mock.invocationCallOrder[0]!,
      );
    },
  );
  it('supports a partial receipt as the same ordinary persisted session without a destination', async () => {
    const ports = fixture();
    const partial = { id: 'persisted-partial', state: 'failed' };
    expect(await handoffSession(partial, ports, { history: 'load', isCurrent: () => true })).toBe(
      true,
    );
    expect(ports.publish).toHaveBeenCalledExactlyOnceWith(partial);
    expect(ports.select).toHaveBeenCalledExactlyOnceWith(partial, 'load');
    expect(ports.saveSelectedSession).toHaveBeenCalledExactlyOnceWith(partial.id);
  });
  it('keeps a session discoverable after its initiating caller is stale without selecting or navigating', async () => {
    const ports = fixture();
    const present = vi.fn();
    expect(
      await handoffSession(session, ports, { history: 'load', isCurrent: () => false, present }),
    ).toBe(false);
    expect(ports.publish).toHaveBeenCalledWith(session);
    expect(ports.refreshRoster).toHaveBeenCalledOnce();
    expect(ports.select).not.toHaveBeenCalled();
    expect(ports.readDraft).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });
  it.each(['roster', 'draft'] as const)(
    'fences stale %s completion from overwriting another draft or navigation',
    async (boundary) => {
      const ports = fixture();
      const present = vi.fn();
      let current = true;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (boundary === 'roster') ports.refreshRoster.mockImplementationOnce(() => gate);
      else
        ports.readDraft.mockImplementationOnce(async () => {
          await gate;
          return draft;
        });
      const pending = handoffSession(session, ports, {
        history: 'load',
        isCurrent: () => current,
        present,
      });
      try {
        await vi.waitFor(() =>
          expect(
            boundary === 'roster' ? ports.refreshRoster : ports.readDraft,
          ).toHaveBeenCalledOnce(),
        );
        current = false;
        release();
        expect(await pending).toBe(false);
        expect(ports.restoreDraft).not.toHaveBeenCalled();
        expect(present).not.toHaveBeenCalled();
      } finally {
        release();
        await pending;
      }
    },
  );
  it('propagates a draft read failure for the shared notification caller without losing the session', async () => {
    const ports = fixture();
    const present = vi.fn();
    ports.readDraft.mockRejectedValueOnce(new Error('Draft unavailable'));
    await expect(
      handoffSession(session, ports, { history: 'load', isCurrent: () => true, present }),
    ).rejects.toThrow('Draft unavailable');
    expect(ports.publish).toHaveBeenCalledWith(session);
    expect(ports.select).toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
  });
});

describe('ordinary Open presentation ownership', () => {
  it.each(['navigation', 'handoff'] as const)(
    'releases a held draft Open on %s and suppresses its stale draft',
    async (replacement) => {
      const changed = vi.fn();
      const presentation = new SessionPresentation(changed);
      const open = presentation.beginOpen('old');
      let release!: () => void;
      const draftRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      const restore = vi.fn();
      const pending = (async () => {
        try {
          await draftRead;
          if (open.isCurrent()) restore(draft);
        } finally {
          open.finish();
        }
      })();
      try {
        expect(changed).toHaveBeenLastCalledWith('old');
        if (replacement === 'navigation') presentation.invalidate();
        else presentation.begin();
        expect(changed).toHaveBeenLastCalledWith(null);
        release();
        await pending;
        expect(restore).not.toHaveBeenCalled();
        expect(changed).toHaveBeenLastCalledWith(null);
      } finally {
        release();
        await pending;
      }
    },
  );
  it('does not let an older held Open clear a newer Open indicator', async () => {
    const changed = vi.fn();
    const presentation = new SessionPresentation(changed);
    const old = presentation.beginOpen('old');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = gate.finally(old.finish);
    try {
      presentation.invalidate();
      const latest = presentation.beginOpen('latest');
      release();
      await pending;
      expect(old.isCurrent()).toBe(false);
      expect(latest.isCurrent()).toBe(true);
      expect(changed).toHaveBeenLastCalledWith('latest');
      latest.finish();
      expect(changed).toHaveBeenLastCalledWith(null);
    } finally {
      release();
      await pending;
    }
  });
  it('disposal invalidates both presentation and the current Open busy owner', () => {
    const changed = vi.fn();
    const presentation = new SessionPresentation(changed);
    const open = presentation.beginOpen('selected');
    presentation.dispose();
    expect(open.isCurrent()).toBe(false);
    expect(changed).toHaveBeenLastCalledWith(null);
    const count = changed.mock.calls.length;
    open.finish();
    expect(changed).toHaveBeenCalledTimes(count);
  });
});
