/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, type Page } from '@playwright/test';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { chatSnapshot } from './chat-snapshot-fixture.js';
import { newSessionFallback } from '../../src/shared/contracts/session-defaults.js';
import type {
  OrgPlanPreparation,
  OrgPlanLaunchRequest,
} from '../../src/shared/contracts/org-plan-execution.js';
import type { SupervisedPlan } from '../../src/client/features/plans/contracts.js';
import type { RelaySession } from '../../src/client/features/sessions/relay-client.js';

export const executeProjectPath = '/srv/Workspace with spaces/Καλημέρα/Project 長い名前';
export const executePlanName = '.gestalt/Long roadmap plan.org';
export const executeSourcePath = `${executeProjectPath}/${executePlanName}`;
export type ExecuteEntry = 'catalog' | 'linked' | 'retained';
export type ExecuteRenderer = 'supervised' | 'org-source';

export async function installExecuteFixture(
  page: Page,
  options: { entry?: ExecuteEntry; renderer?: ExecuteRenderer; defaultProfile?: string } = {},
) {
  await mockAuthenticatedStatus(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { copiedPath?: string }).copiedPath = value;
        },
      },
    }),
  );
  const plan: SupervisedPlan = {
    title: 'Project roadmap',
    sourcePath: executeSourcePath,
    currentStepId: 'work',
    totalSteps: 1,
    doneSteps: 0,
    allDone: false,
    steps: [
      {
        id: 'work',
        title: 'Deliver the requested change',
        level: 1,
        state: 'TODO' as const,
        priority: 'A' as const,
        reviewStatus: 'UNREVIEWED' as const,
        skills: ['$gestalt:coding'],
        description: { goal: 'Keep the project work reviewable.' },
        children: [],
      },
    ],
  };
  const raw = {
    kind: 'org-source' as const,
    planName: executePlanName,
    title: plan.title,
    sourcePath: executeSourcePath,
    source:
      '#+TITLE: Project roadmap\n\n* TODO Deliver the requested change\n:PROPERTIES:\n:ID: work\n:SKILLS: $gestalt:coding\n:REVIEW_STATUS: UNREVIEWED\n:END:\n- Goal :: Keep the project work reviewable.',
  };
  const plain = {
    kind: 'org-source' as const,
    planName: '.gestalt/Plain notes.org',
    title: 'Plain notes',
    sourcePath: `${executeProjectPath}/.gestalt/Plain notes.org`,
    source: '#+TITLE: Plain notes\n* Meeting notes\nAn ordinary Org document.',
  };
  const off = {
    state: 'disabled' as const,
    enabled: false,
    retry: { position: 0, limit: 3 },
    updatedAt: '2026-11-08T00:00:00Z',
  };
  const source: RelaySession = {
    id: 'source-session',
    state: 'ready',
    workspaceId: 'root',
    workspacePath: executeProjectPath,
    provider: 'codex',
    model: newSessionFallback.model,
    threadId: 'source-thread',
    ...(options.entry === 'retained'
      ? {
          plan,
          lastOrgPlan: {
            filename: executePlanName,
            path: executeSourcePath,
            title: plan.title,
            attached: false,
          },
        }
      : {}),
  };
  const created: RelaySession = {
    id: 'launched-supervisor',
    state: 'ready',
    workspaceId: 'root',
    workspacePath: executeProjectPath,
    provider: 'codex',
    model: newSessionFallback.model,
    threadId: 'launched-thread',
    autopilot: off,
    effectiveSkillSelection: {
      selectedProfileName: options.defaultProfile ?? '',
      skills: [],
      warnings: [],
    },
  };
  const state = {
    revision: 'original',
    profiles: ['supervisor'],
    defaultProfile: options.defaultProfile ?? '',
    readError: false,
    blocked: null as Extract<OrgPlanPreparation, { kind: 'blocked' }> | null,
    published: false,
    activated: false,
    launchRequests: [] as OrgPlanLaunchRequest[],
    opens: [] as string[],
    toggles: [] as string[],
    prepareCount: 0,
    prepareGate: null as Promise<void> | null,
    launchGate: null as Promise<void> | null,
    socket: null as { send(message: string): void } | null,
  };
  const roster = () => (state.published ? [source, created] : [source]);
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      json: {
        workspaces: [
          { id: 'root', name: 'Project', relativePath: '.', isGitRepository: true, children: [] },
        ],
        profiles: [],
        sessions: roster(),
        models: { codex: [newSessionFallback.model], kimi: [] },
      },
    }),
  );
  await page.route('**/api/skill-profiles', (route) => route.fulfill({ json: { profiles: [] } }));
  await page.route('**/api/sessions/recent-threads', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions', (route) => route.fulfill({ json: roster() }));
  for (const session of [source, created]) {
    await page.route(`**/api/sessions/${session.id}`, (route) => route.fulfill({ json: session }));
    await page.route(`**/api/sessions/${session.id}/history`, (route) =>
      route.fulfill({
        json: chatSnapshot({
          items: [
            {
              id: `${session.id}-message`,
              kind: session === source ? 'agent' : 'user',
              text:
                session === source
                  ? `Open [the roadmap](${encodeURI(executeSourcePath)}).`
                  : 'Supervise the exact project roadmap with the Org plan workflow.',
            },
          ],
        }),
      }),
    );
    await page.route(`**/api/sessions/${session.id}/plan`, (route) => {
      if (route.request().method() === 'PUT') {
        state.opens.push(session.id);
        return route.fulfill({ json: options.renderer === 'org-source' ? raw : plan });
      }
      return session.plan ? route.fulfill({ json: session.plan }) : route.fulfill({ status: 204 });
    });
    await page.route(`**/api/sessions/${session.id}/autopilot`, (route) => {
      state.toggles.push(session.id);
      return route.fulfill({ json: { autopilot: session.autopilot ?? off } });
    });
  }
  await page.routeWebSocket(/\/api\/sessions\/source-session\/events\?/, () => {});
  await page.routeWebSocket(/\/api\/sessions\/launched-supervisor\/events\?/, (socket) => {
    state.socket = socket;
  });
  await page.route('**/api/workspaces/root/plans', (route) =>
    route.fulfill({
      json: [
        {
          planName: executePlanName,
          title: plan.title,
          previewAvailable: true,
          totalSteps: 1,
          doneSteps: 0,
          allDone: false,
        },
        { planName: plain.planName, title: plain.title, previewAvailable: false },
      ],
    }),
  );
  await page.route('**/api/workspaces/root/plans/*', (route) =>
    route.fulfill({
      json:
        decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!) ===
        plain.planName
          ? plain
          : options.renderer === 'org-source'
            ? raw
            : plan,
    }),
  );
  await page.route('**/api/plans/prepare', async (route) => {
    state.prepareCount += 1;
    if (state.prepareGate) await state.prepareGate;
    if (state.readError)
      return route.fulfill({ status: 503, json: { code: 'SKILL_PROFILE_READ_FAILED' } });
    const input = route.request().postDataJSON();
    if (state.blocked) return route.fulfill({ json: state.blocked });
    if (input.planName === plain.planName)
      return route.fulfill({
        json: {
          kind: 'blocked',
          code: 'INVALID_PLAN',
          reason: 'This Org document is not a valid Gestalt plan.',
        },
      });
    if (input.skillProfile && !state.profiles.includes(input.skillProfile))
      return route.fulfill({
        json: {
          kind: 'blocked',
          code: 'SKILL_PROFILE_UNAVAILABLE',
          reason: 'The selected skill profile is unavailable. Choose another profile.',
        },
      });
    return route.fulfill({
      json: {
        kind: 'eligible',
        reference:
          input.kind === 'retained-session'
            ? { kind: input.kind, sessionId: input.sessionId }
            : {
                kind: input.kind,
                ...(input.kind === 'session'
                  ? { sessionId: input.sessionId }
                  : { workspaceId: input.workspaceId }),
                planName: input.planName,
              },
        title: plan.title,
        sourcePath: executeSourcePath,
        revision: state.revision,
        workspace: { id: 'root', name: 'Project', path: executeProjectPath },
        settings: {
          ...newSessionFallback,
          provider: 'codex',
          profile: 'default',
          skillProfile: state.defaultProfile,
        },
        skillProfiles: state.profiles.map((name) => ({ name })),
        warnings: [],
      },
    });
  });
  await page.route('**/api/plans/execute', async (route) => {
    const input: OrgPlanLaunchRequest = route.request().postDataJSON();
    state.launchRequests.push(input);
    if (state.launchGate) await state.launchGate;
    if (input.expectedRevision !== state.revision)
      return route.fulfill({
        status: 409,
        json: {
          kind: 'blocked',
          code: 'CONTEXT_CHANGED',
          reason: 'The plan changed. Refresh the plan and confirm again.',
        },
      });
    if (input.skillProfile && !state.profiles.includes(input.skillProfile))
      return route.fulfill({
        json: {
          kind: 'blocked',
          code: 'SKILL_PROFILE_UNAVAILABLE',
          reason: 'The selected skill profile disappeared. Choose another profile.',
        },
      });
    state.published = true;
    created.effectiveSkillSelection!.selectedProfileName = input.skillProfile;
    return route.fulfill({
      json: {
        kind: 'started',
        launchId: input.launchId,
        session: { id: created.id, state: created.state },
        bootstrap: { kind: 'accepted', requestId: 'bootstrap', turnId: 'turn' },
      },
    });
  });
  return {
    state,
    plan,
    source,
    created,
    activate: () => {
      state.activated = true;
      created.plan = plan;
      created.lastOrgPlan = {
        filename: executePlanName,
        title: plan.title,
        path: executeSourcePath,
        attached: true,
      };
      created.autopilot = { ...off, state: 'monitoring', enabled: true };
      for (const event of [
        { sequence: 1, type: 'plan.updated', payload: { plan, reason: 'supervision-start' } },
        { sequence: 2, type: 'autopilot.updated', payload: created.autopilot },
      ])
        state.socket!.send(JSON.stringify({ type: 'relay.event', event }));
    },
  };
}

export async function openExecuteEntry(page: Page, entry: ExecuteEntry) {
  const primary = page.getByLabel('Primary');
  if (entry === 'linked') {
    await primary.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Execute', exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'the roadmap' }).click();
  } else {
    await primary.getByRole('button', { name: 'Plan', exact: true }).click();
    if (entry === 'catalog') {
      const close = page.getByRole('button', { name: 'Close plan and return to list' });
      if (await close.count()) await close.click();
      await page.getByRole('button', { name: 'Open Project roadmap' }).click();
    }
  }
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeEnabled();
}
