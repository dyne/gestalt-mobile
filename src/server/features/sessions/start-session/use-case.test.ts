import { describe, expect, it } from 'vitest';
import { startSession } from './use-case.js';

describe('startSession', () => {
  it('creates and persists a starting session', async () => {
    const saved: unknown[] = [];
    const result = await startSession(
      { workspaceId: 'w', profile: 'default' },
      {
        createId: () => 's',
        now: () => 't',
        save: (session) => saved.push(session),
        workspaces: {
          resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
        },
        profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      },
    );
    expect(result.id).toBe('s');
    expect(result.workspacePath).toBe('/relay/workspace');
    expect(saved).toHaveLength(1);
  });

  it('forwards direct Codex session settings to the runtime activation port', async () => {
    let received: unknown;
    const input = {
      workspaceId: 'w',
      profile: 'default',
      model: 'gpt-5.4',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    } as const;
    await startSession(input, {
      createId: () => 's',
      now: () => 't',
      save: () => {},
      workspaces: {
        resolve: async () => ({ id: 'w', name: 'workspace', realPath: '/relay/workspace' }),
      },
      profiles: { require: async () => ({ name: 'default', state: 'ok', status: 'ready' }) },
      activate: async function (session) {
        received = arguments[1];
        return session;
      },
    });

    expect(received).toEqual({
      model: 'gpt-5.4',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
  });
});
