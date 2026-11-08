/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExecutePlanAction from './ExecutePlanAction.svelte';
import { tick } from 'svelte';
import type {
  OrgPlanPreparation,
  OrgPlanLaunchResult,
} from '../../../shared/contracts/org-plan-execution.js';
import { newSessionFallback } from '../../../shared/contracts/session-defaults.js';

const reference = {
  kind: 'workspace' as const,
  workspaceId: 'project',
  planName: '.gestalt/plan.org',
};
const eligible: Extract<OrgPlanPreparation, { kind: 'eligible' }> = {
  kind: 'eligible',
  reference,
  title: 'Plan',
  revision: 'seen',
  sourcePath: '/project/.gestalt/plan.org',
  workspace: { id: 'project', path: '/project', name: 'Project' },
  settings: { ...newSessionFallback, provider: 'codex', profile: 'default', skillProfile: '' },
  skillProfiles: [{ name: 'supervisor' }, { name: 'broken', error: 'Unreadable' }],
  warnings: [],
};
const started: OrgPlanLaunchResult = {
  kind: 'started',
  launchId: 'stable',
  session: { id: 'ordinary', state: 'idle' },
  bootstrap: { kind: 'accepted', requestId: 'bootstrap', turnId: 'turn' },
};
function setup(preparation: OrgPlanPreparation = eligible) {
  const transport = {
    prepareOrgPlanSupervision: vi.fn().mockResolvedValue(preparation),
    startOrgPlanSupervision: vi.fn().mockResolvedValue(started),
  };
  const onerror = vi.fn();
  const onresult = vi.fn();
  const view = render(ExecutePlanAction, { reference, transport, onerror, onresult });
  return { ...view, transport, onerror, onresult };
}
async function open() {
  const execute = screen.getByRole('button', { name: 'Execute' });
  await waitFor(() => expect((execute as HTMLButtonElement).disabled).toBe(false));
  await fireEvent.click(execute);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(false),
  );
  return execute;
}
// jsdom has no native modal implementation. These scoped shims cover component
// event/state contracts only; focus trapping and keyboard behavior need a browser.
const dialogMethods = ['showModal', 'close'] as const;
let originalDialogMethods: Map<string, PropertyDescriptor | undefined>;
beforeEach(() => {
  originalDialogMethods = new Map(
    dialogMethods.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
    ]),
  );
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      writable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      writable: true,
      value: function (this: HTMLDialogElement) {
        if (this.open) {
          this.open = false;
          this.dispatchEvent(new Event('close'));
        }
      },
    },
  });
});
afterEach(() => {
  cleanup();
  for (const name of dialogMethods) {
    const original = originalDialogMethods.get(name);
    if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
  vi.restoreAllMocks();
});

describe('Execute plan confirmation', () => {
  it.each([
    'INVALID_PLAN',
    'NO_REMAINING_WORK',
    'CODEX_UNAVAILABLE',
    'ACTIVE_SUPERVISION',
  ] as const)('keeps %s visibly disabled with an accessible reason', async (code) => {
    const { transport } = setup({ kind: 'blocked', code, reason: 'Cannot execute this plan.' });
    const action = screen.getByRole('button', { name: 'Execute' });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    await screen.findByText('Cannot execute this plan.');
    expect(action.getAttribute('aria-describedby')).toBeTruthy();
    await fireEvent.click(action);
    expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps unknown availability disabled and reports read failure through the shared caller', async () => {
    const transport = {
      prepareOrgPlanSupervision: vi.fn().mockRejectedValue(new Error('Profile read failed')),
      startOrgPlanSupervision: vi.fn(),
    };
    const onerror = vi.fn();
    render(ExecutePlanAction, { reference, transport, onerror });
    expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await waitFor(() => expect(onerror).toHaveBeenCalledWith('Profile read failed'));
    expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it.each(['Cancel', 'Escape'])(
    'creates nothing before confirmation and restores focus on %s',
    async (action) => {
      const { transport } = setup();
      const execute = await open();
      expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
      expect(screen.getByRole('combobox', { name: 'Supervisor Skill profile' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'broken' })).toBeNull();
      if (action === 'Cancel')
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      else await fireEvent(screen.getByRole('dialog'), new Event('cancel'));
      await waitFor(() => expect(document.activeElement).toBe(execute));
      expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
    },
  );
  it.each(['', 'supervisor'])(
    'submits only the confirmed %s profile with a single repeated OK guard',
    async (profile) => {
      const { transport, onresult } = setup();
      await open();
      if (profile) {
        await fireEvent.change(screen.getByRole('combobox'), { target: { value: profile } });
      }
      let finish!: (value: OrgPlanLaunchResult) => void;
      transport.startOrgPlanSupervision.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      try {
        const ok = screen.getByRole('button', { name: 'OK' });
        await waitFor(() => expect((ok as HTMLButtonElement).disabled).toBe(false));
        await fireEvent.click(ok);
        await fireEvent.click(ok);
        expect(transport.startOrgPlanSupervision).toHaveBeenCalledTimes(1);
        expect(transport.startOrgPlanSupervision.mock.calls[0]![0]).toMatchObject({
          reference,
          expectedRevision: 'seen',
          skillProfile: profile,
        });
        finish(started);
        await waitFor(() => expect(onresult).toHaveBeenCalledWith(started));
      } finally {
        finish?.(started);
        await tick();
      }
    },
  );
  it('supports Default with no saved profiles and preserves a disappeared selected default', async () => {
    const { transport } = setup({
      ...eligible,
      settings: { ...eligible.settings, skillProfile: 'deleted' },
      skillProfiles: [],
    });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
    await screen.findByText('Choose an available skill profile.');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('deleted');
    expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
  });
  it('reports changed-source rejection without another launch or silent profile fallback', async () => {
    const { transport, onerror } = setup();
    await open();
    transport.startOrgPlanSupervision.mockResolvedValue({
      kind: 'blocked',
      code: 'CONTEXT_CHANGED',
      reason: 'Refresh the changed plan.',
    });
    await fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(onerror).toHaveBeenCalledWith('Refresh the changed plan.'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('closing a submitted launch does not cancel its persisted operation and retry uses the same identity', async () => {
    const { transport } = setup();
    await open();
    transport.startOrgPlanSupervision.mockRejectedValueOnce(new Error('Response lost'));
    await fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await screen.findByText('Response lost');
    await fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(transport.startOrgPlanSupervision).toHaveBeenCalledTimes(2));
    expect(transport.startOrgPlanSupervision.mock.calls[0]![0].launchId).toBe(
      transport.startOrgPlanSupervision.mock.calls[1]![0].launchId,
    );
  });
  it('focuses the initial profile once the fresh read enables it', async () => {
    setup();
    await open();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox')));
  });
  it('does not steal focus from Cancel when the user moves during the fresh read', async () => {
    const { transport } = setup();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    let release!: (value: OrgPlanPreparation) => void;
    transport.prepareOrgPlanSupervision.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    try {
      await fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      await fireEvent.pointerDown(cancel);
      cancel.focus();
      release(eligible);
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      expect(document.activeElement).toBe(cancel);
    } finally {
      release?.(eligible);
      await tick();
    }
  });
  it('keeps confirmation disabled while fresh profiles load and allows cancellation without effects', async () => {
    const { transport } = setup();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    let resolve!: (value: OrgPlanPreparation) => void;
    transport.prepareOrgPlanSupervision.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const execute = screen.getByRole('button', { name: 'Execute' });
    try {
      await fireEvent.click(execute);
      expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true);
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(document.activeElement).toBe(execute));
      resolve(eligible);
      expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
    } finally {
      resolve?.(eligible);
      await tick();
    }
  });
  it('closes stale confirmation when the viewed source changes and starts disabled again', async () => {
    const { transport, rerender } = setup();
    await open();
    transport.prepareOrgPlanSupervision.mockResolvedValue({
      kind: 'blocked',
      code: 'INVALID_PLAN',
      reason: 'The changed file is invalid.',
    });
    await rerender({ reference: { ...reference, planName: '.gestalt/changed.org' }, transport });
    await screen.findByText('The changed file is invalid.');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
  });
  it('retains the persisted result after dismissing a submitted request without claiming cancellation', async () => {
    const { transport, onresult } = setup();
    await open();
    let finish!: (value: OrgPlanLaunchResult) => void;
    transport.startOrgPlanSupervision.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    try {
      await fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      await screen.findByText(/Closing this dialog does not cancel/);
      await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      finish(started);
      await waitFor(() => expect(onresult).toHaveBeenCalledWith(started));
    } finally {
      finish?.(started);
      await tick();
    }
  });
  it('blocks confirmation after a failed fresh profile read until explicit successful refresh', async () => {
    const { transport, onerror } = setup();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    transport.prepareOrgPlanSupervision.mockRejectedValueOnce(
      new Error('Fresh profiles unreadable'),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
    await waitFor(() => expect(onerror).toHaveBeenCalledWith('Fresh profiles unreadable'));
    const ok = screen.getByRole('button', { name: 'OK' });
    expect((ok as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    await fireEvent.click(ok);
    expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect((ok as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(ok);
    await waitFor(() => expect(transport.startOrgPlanSupervision).toHaveBeenCalledTimes(1));
  });
  it('invalidates confirmation during a held submission when context changes and suppresses its stale presentation', async () => {
    const { transport, onresult, rerender } = setup();
    await open();
    let finish!: (value: OrgPlanLaunchResult) => void;
    transport.startOrgPlanSupervision.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    try {
      await fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      expect(transport.startOrgPlanSupervision).toHaveBeenCalledTimes(1);
      const changed = { ...reference, planName: '.gestalt/other.org' };
      transport.prepareOrgPlanSupervision.mockResolvedValue({
        ...eligible,
        reference: changed,
        revision: 'other-revision',
      });
      await rerender({ reference: changed, transport, onresult });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      finish(started);
      await tick();
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      expect(onresult).not.toHaveBeenCalled();
      await open();
      await fireEvent.click(screen.getByRole('button', { name: 'OK' }));
      await waitFor(() => expect(transport.startOrgPlanSupervision).toHaveBeenCalledTimes(2));
      expect(transport.startOrgPlanSupervision.mock.calls[1]![0]).toMatchObject({
        reference: changed,
        expectedRevision: 'other-revision',
      });
    } finally {
      finish?.(started);
      await tick();
    }
  });
  it('does not let a stale profile refresh release a newer confirmation check', async () => {
    const { transport } = setup();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Execute' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    let releaseOld!: (value: OrgPlanPreparation) => void;
    let releaseNew!: (value: OrgPlanPreparation) => void;
    transport.prepareOrgPlanSupervision
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            releaseOld = done;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            releaseNew = done;
          }),
      );
    try {
      await fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await fireEvent.click(screen.getByRole('button', { name: 'Execute' }));
      releaseOld(eligible);
      await tick();
      expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(true);
      expect(transport.startOrgPlanSupervision).not.toHaveBeenCalled();
      releaseNew(eligible);
      await waitFor(() =>
        expect((screen.getByRole('button', { name: 'OK' }) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
    } finally {
      releaseOld?.(eligible);
      releaseNew?.(eligible);
      await tick();
    }
  });
});
