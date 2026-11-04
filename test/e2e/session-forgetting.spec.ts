/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  expect,
  test,
  type Locator,
  type Page,
  type Request as PlaywrightRequest,
  type TestInfo,
} from '@playwright/test';
import type { SessionForgetOperation } from '../../src/shared/contracts/session-forget.js';
import { mockAuthenticatedStatus } from './auth-fixture.js';
import { ChatRelayFixture, deferred } from './chat-relay-fixture.js';
import {
  expectCleanThemeDiagnostics,
  expectNoHorizontalOverflow,
  openThemeEvidence,
} from './theme-evidence.js';

type FetchWitness = {
  kind: 'resolved' | 'rejected';
  id: string;
  url: string;
  method: string;
  status?: number;
  ok?: boolean;
  bodyUsed?: boolean;
  error?: string;
};
const witnessHeader = 'x-gestalt-test-request';

async function observeFetchResolution(page: Page, witnesses: FetchWitness[]) {
  await page.exposeBinding('__sessionFetchWitness', (_source: unknown, witness: FetchWitness) => {
    witnesses.push(witness);
  });
  await page.addInitScript((header) => {
    const sink = window as Window & {
      __sessionFetchWitness: (witness: FetchWitness) => Promise<void>;
    };
    const nativeFetch = window.fetch.bind(window);
    const documentId = crypto.randomUUID();
    let sequence = 0;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const relevant =
        url.origin === location.origin &&
        ((method === 'GET' && url.pathname === '/api/sessions/other-owner/plan') ||
          ((method === 'GET' || method === 'DELETE') &&
            url.pathname === '/api/sessions/forget-owner'));
      if (!relevant) return nativeFetch(input, init);
      const id = documentId + ':' + ++sequence;
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set(header, id);
      try {
        const response = await nativeFetch(input, { ...init, headers });
        // Observe the exact native response without consuming its body, waiting
        // for telemetry, or replacing the object supplied to the client.
        void sink
          .__sessionFetchWitness({
            kind: 'resolved',
            id,
            url: url.href,
            method,
            status: response.status,
            ok: response.ok,
            bodyUsed: response.bodyUsed,
          })
          .catch(() => {});
        return response;
      } catch (error) {
        void sink
          .__sessionFetchWitness({
            kind: 'rejected',
            id,
            url: url.href,
            method,
            error: String(error),
          })
          .catch(() => {});
        throw error;
      }
    };
  }, witnessHeader);
}

async function captureFrame(page: Page, frame: Locator, testInfo: TestInfo, name: string) {
  await expectNoHorizontalOverflow(page);
  const metrics = await frame.evaluate((element) => {
    const text = element.querySelector('.session-forget-status')!;
    const title = element.querySelector('.org-plan-title')!;
    return {
      statusWidth: text.clientWidth,
      titleWidth: title.clientWidth,
      contentFits: element.scrollWidth <= element.clientWidth,
      spinnerAnimation: element.querySelector('.forget-spinner')
        ? getComputedStyle(element.querySelector('.forget-spinner')!).animationName
        : null,
    };
  });
  expect(metrics.contentFits, JSON.stringify(metrics)).toBe(true);
  expect(metrics.statusWidth).toBeGreaterThan(140);
  expect(metrics.titleWidth).toBeGreaterThan(140);
  if ((await frame.getAttribute('aria-busy')) === 'true')
    expect(metrics.spinnerAnimation).toBe('none');
  // A long card can exceed the viewport at 200% text. Capture its feedback and
  // keyboard action separately, with the real sticky chrome left in place.
  const status = frame.getByRole('status');
  await status.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expectUnobscured(status);
  await page.screenshot({ path: testInfo.outputPath(`${name}-status-viewport.png`) });
  await page.keyboard.press('Tab');
  const control = frame.getByRole('button', { name: /^(Copy CLI|Retry Forget)$/ }).last();
  await control.focus();
  await control.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expect(control).toBeFocused();
  await expect
    .poll(() => control.evaluate((element) => getComputedStyle(element).outlineStyle))
    .not.toBe('none');
  await expectUnobscured(control);
  await page.screenshot({ path: testInfo.outputPath(`${name}-action-viewport.png`) });
}

async function expectUnobscured(target: Locator) {
  await expect(target).toBeInViewport({ ratio: 1 });
  const bounds = await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const header = document.querySelector('.app-header')?.getBoundingClientRect();
    const navigation = document.querySelector('.bottom-navigation')?.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      top: box.top,
      bottom: box.bottom,
      headerBottom: header?.bottom ?? 0,
      navigationTop: navigation?.top ?? innerHeight,
      uncovered: hit !== null && element.contains(hit),
    };
  });
  expect(bounds.top, JSON.stringify(bounds)).toBeGreaterThanOrEqual(bounds.headerBottom - 0.5);
  expect(bounds.bottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.navigationTop + 0.5);
  expect(bounds.uncovered, JSON.stringify(bounds)).toBe(true);
}

async function applyFontScale(page: Page, fontScale: 100 | 200) {
  // The production breakpoint observer watches root attributes. A stylesheet
  // injection alone does not notify it when the computed font size changes.
  await page.locator('html').evaluate((element, scale) => {
    element.style.setProperty('font-size', `${scale}%`, 'important');
  }, fontScale);
  await expect
    .poll(() => page.locator('html').evaluate((element) => getComputedStyle(element).fontSize))
    .toBe(`${(16 * fontScale) / 100}px`);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  for (const fontScale of [100, 200] as const) {
    test(`session forgetting lifecycle ${viewport.width}x${viewport.height} font${fontScale}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const witnesses: FetchWitness[] = [];
      await observeFetchResolution(page, witnesses);
      const contexts: { operation: string }[] = [{ operation: 'bootstrap' }];
      const context = (operation: string) => {
        contexts.push({ operation });
      };
      const requestStarts = new WeakMap<PlaywrightRequest, number>();
      const responses = new WeakMap<PlaywrightRequest, { status: number; ok: boolean }>();
      const noContentResponses = new Set<string>();
      const pendingOwnerReads = new Set<PlaywrightRequest>();
      const failures: {
        url: string;
        method: string;
        errorText: string | null;
        startedDuring: string | null;
        failedDuring: string;
        operations: { operation: string }[];
        tag: string | null;
        responseStatus: number | null;
        responseOk: boolean | null;
      }[] = [];
      page.on('request', (request) => {
        requestStarts.set(request, contexts.length - 1);
        if (
          request.method() === 'GET' &&
          new URL(request.url()).pathname === '/api/sessions/forget-owner'
        )
          pendingOwnerReads.add(request);
      });
      page.on('response', (response) => {
        responses.set(response.request(), { status: response.status(), ok: response.ok() });
        const tag = response.request().headers()[witnessHeader];
        if (response.status() === 204 && tag) noContentResponses.add(tag);
      });
      page.on('requestfinished', (request) => pendingOwnerReads.delete(request));
      page.on('requestfailed', (request) => {
        pendingOwnerReads.delete(request);
        const start = requestStarts.get(request);
        failures.push({
          url: request.url(),
          method: request.method(),
          errorText: request.failure()?.errorText ?? null,
          startedDuring: start === undefined ? null : contexts[start]!.operation,
          failedDuring: contexts.at(-1)!.operation,
          operations: start === undefined ? [] : contexts.slice(start),
          tag: request.headers()[witnessHeader] ?? null,
          responseStatus: responses.get(request)?.status ?? null,
          responseOk: responses.get(request)?.ok ?? null,
        });
      });
      await mockAuthenticatedStatus(page);
      const fixture = new ChatRelayFixture(page);
      const other = {
        id: 'other-owner',
        state: 'ready',
        threadId: 'other-thread',
        workspaceId: 'workspace-1',
        workspacePath: '/workspace/another-session-remains-usable',
        model: 'gpt-5.6-terra',
      };
      const target: Record<string, unknown> = {
        id: 'forget-owner',
        state: 'released',
        threadId: 'forgotten-history',
        workspaceId: 'workspace-1',
        workspacePath:
          '/workspace/a-session-with-an-extraordinarily-long-workspace-and-repository-name',
        resumeCommand: 'codex resume forgotten-history',
        model: 'gpt-5.6-terra',
        lastOrgPlan: {
          filename: 'a-long-session-plan.org',
          title: 'A long session title that stays readable while its temporary files are removed',
          attached: false,
        },
      };
      await fixture.install([other, target]);
      // Supply every optional startup contract used by these actual surfaces.
      // Unexpected requests still reach the server and fail diagnostics.
      await page.route('**/api/skill-profiles', (route) =>
        route.fulfill({ json: { profiles: [] } }),
      );
      await page.route('**/api/session-models/*', (route) =>
        route.fulfill({ json: { models: ['gpt-6.1-sol', 'gpt-5.6-terra'] } }),
      );
      await page.route('**/api/sessions/*/plan', (route) => route.fulfill({ status: 204 }));
      const requests: ReturnType<typeof deferred<{ status: number; body?: unknown }>>[] = [];
      const deleteRequests: PlaywrightRequest[] = [];
      const routeSettlements: Promise<void>[] = [];
      let completionWitness: {
        tag: string;
        rosterStillPresent: true;
        frameRemoved: true;
        recentPlaced: true;
      } | null = null;
      const setPhase = (phase: SessionForgetOperation['phase']) => {
        target.forgetOperation = {
          sessionId: target.id,
          operationId: 'durable-operation',
          phase,
          updatedAt: new Date().toISOString(),
          ...(phase === 'failed' ? { failureCode: 'SESSION_CLEANUP_FAILED' } : {}),
        };
      };
      await page.route(/\/api\/sessions\/(forget-owner|other-owner)$/, async (route) => {
        const id = route.request().url().split('/').at(-1);
        if (route.request().method() === 'DELETE') {
          setPhase('stopping');
          const response = deferred<{ status: number; body?: unknown }>();
          requests.push(response);
          deleteRequests.push(route.request());
          const settled = deferred<void>();
          routeSettlements.push(settled.promise);
          const result = await response.promise;
          try {
            await route.fulfill({
              status: result.status,
              ...(result.body ? { json: result.body } : {}),
            });
          } finally {
            settled.resolve();
          }
        } else {
          const session = fixture.sessions.find((item) => item.id === id);
          await route.fulfill(
            session ? { json: session } : { status: 404, json: { code: 'SESSION_NOT_FOUND' } },
          );
        }
      });
      const diagnostics = await openThemeEvidence(page, { theme: 'dyne-org', fontScale, url: '/' });
      await applyFontScale(page, fontScale);
      const frame = () => page.locator('[data-session-id="forget-owner"]');
      const otherFrame = () => page.locator('[data-session-id="other-owner"]');
      try {
        context('select Sessions');
        await page.getByRole('button', { name: 'Sessions', exact: true }).click();
        context('request Forget');
        await frame().getByRole('button', { name: 'Forget', exact: true }).click();
        await expect(frame()).toHaveAttribute('aria-busy', 'true');
        await expect(frame().getByRole('status')).toContainText('Forgetting session…');
        await expect(frame().getByRole('button', { name: 'Forget', exact: true })).toBeDisabled();
        // Send an actual pointer activation rather than dispatching a synthetic
        // click event, which can bypass native disabled-control behavior.
        await frame().getByRole('button', { name: 'Forget', exact: true }).click({ force: true });
        await expect(frame().getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
        await expect.poll(() => requests.length).toBe(1);
        await expect(page.getByRole('list', { name: 'Recent sessions' })).toHaveCount(0);
        context('focus Sessions busy frame');
        await captureFrame(page, frame(), testInfo, 'sessions-busy');

        context('observe cleaning');
        setPhase('cleaning');
        await expect(frame().getByRole('status')).toContainText('Removing temporary files…');
        // Lose the request response while the durable backend operation continues.
        requests[0]!.resolve({ status: 503, body: { code: 'SESSION_FORGET_FAILED' } });
        await expect(frame()).toHaveAttribute('aria-busy', 'true');
        context('open other session');
        await otherFrame().getByRole('button', { name: 'Open', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
        await page
          .getByRole('textbox', { name: 'Prompt' })
          .fill('This other session is still usable');
        await expect(page.getByRole('button', { name: 'Send prompt' })).toBeEnabled();
        const historyReads = fixture.protocol.filter((item) => item.kind === 'history').length;
        context('reconnect other session');
        fixture.close('other-owner');
        await expect
          .poll(() => fixture.protocol.filter((item) => item.kind === 'history').length)
          .toBeGreaterThan(historyReads);

        const sidebar = page.getByRole('complementary', { name: 'Chat sessions and usage' });
        if (viewport.width >= (88 * 16 * fontScale) / 100) {
          context('focus busy sidebar');
          await expect(sidebar).toBeVisible();
          await captureFrame(
            page,
            sidebar.locator('[data-session-id="forget-owner"]'),
            testInfo,
            'sidebar-busy',
          );
        } else {
          await expect(sidebar).toHaveCount(0);
          context('select responsive Sessions roster');
          await page.getByRole('button', { name: 'Sessions', exact: true }).click();
          await captureFrame(page, frame(), testInfo, 'responsive-roster-busy');
        }
        // Confirm a fresh, fully consumed JSON read before replacing the document.
        // This keeps deliberate reload cancellation out of the transport-error assertion.
        await expect
          .poll(() =>
            [...noContentResponses].every((id) =>
              witnesses.some(
                (witness) =>
                  witness.id === id &&
                  witness.kind === 'resolved' &&
                  witness.status === 204 &&
                  witness.ok === true,
              ),
            ),
          )
          .toBe(true);
        context('confirm cleaning read before reload');
        const settledRead = await page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname === '/api/sessions/forget-owner' &&
            response.status() === 200,
          { timeout: 5000 },
        );
        expect(await settledRead.finished()).toBeNull();
        await expect.poll(() => pendingOwnerReads.size).toBe(0);
        context('reload while cleaning');
        await page.reload();
        await applyFontScale(page, fontScale);
        await expect(frame()).toHaveAttribute('aria-busy', 'true');
        await expect(frame().getByRole('status')).toContainText('Removing temporary files…');
        expect(requests).toHaveLength(1);

        context('observe durable failure');
        setPhase('failed');
        await expect(frame()).toHaveAttribute('aria-busy', 'false');
        await expect(frame().getByRole('button', { name: 'Retry Forget' })).toBeEnabled();
        await expect(page.getByRole('alert')).toContainText('Temporary files could not be removed');
        await expect(frame().getByRole('status')).toContainText(
          'Could not forget this session. Try again.',
        );
        context('focus Sessions failed frame');
        await captureFrame(page, frame(), testInfo, 'sessions-failed');
        context('open other session after failure');
        await otherFrame().getByRole('button', { name: 'Open', exact: true }).click();
        if (viewport.width >= (88 * 16 * fontScale) / 100) {
          context('focus failed sidebar');
          await expect(sidebar).toBeVisible();
          await captureFrame(
            page,
            sidebar.locator('[data-session-id="forget-owner"]'),
            testInfo,
            'sidebar-failed',
          );
        } else {
          await expect(sidebar).toHaveCount(0);
          context('select failed responsive roster');
          await page.getByRole('button', { name: 'Sessions', exact: true }).click();
          await captureFrame(page, frame(), testInfo, 'responsive-roster-failed');
        }
        // Reload also recovers failure; retry is an explicit keyboard action.
        await expect.poll(() => pendingOwnerReads.size).toBe(0);
        await expect
          .poll(() =>
            [...noContentResponses].every((id) =>
              witnesses.some(
                (witness) =>
                  witness.id === id &&
                  witness.kind === 'resolved' &&
                  witness.status === 204 &&
                  witness.ok === true,
              ),
            ),
          )
          .toBe(true);
        context('reload retained failure');
        await page.reload();
        await applyFontScale(page, fontScale);
        await expect(frame().getByRole('button', { name: 'Retry Forget' })).toBeEnabled();
        context('explicit keyboard retry');
        await frame().getByRole('button', { name: 'Retry Forget' }).focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => requests.length).toBe(2);
        await expect(frame()).toHaveAttribute('aria-busy', 'true');
        setPhase('finalizing');
        await expect(frame().getByRole('status')).toContainText('Finishing…');
        context('confirmed completion');
        const retryTag = deleteRequests[1]!.headers()[witnessHeader];
        expect(retryTag).toBeTruthy();
        expect(fixture.sessions.includes(target)).toBe(true);
        await expect(frame()).toHaveCount(1);
        await expect(page.getByRole('list', { name: 'Recent sessions' })).toHaveCount(0);
        requests[1]!.resolve({ status: 204 });
        await expect(frame()).toHaveCount(0);
        await expect(page.getByRole('list', { name: 'Recent sessions' })).toContainText(
          String(target.workspacePath),
        );
        // The read model still contains the owner and reports finalizing; neither
        // a missing-owner poll nor a completed event can produce this placement.
        expect(fixture.sessions.includes(target)).toBe(true);
        await expect
          .poll(() =>
            witnesses.some(
              (witness) =>
                witness.id === retryTag &&
                witness.kind === 'resolved' &&
                witness.method === 'DELETE' &&
                witness.status === 204 &&
                witness.ok === true &&
                witness.bodyUsed === false,
            ),
          )
          .toBe(true);
        completionWitness = {
          tag: retryTag,
          rosterStillPresent: true,
          frameRemoved: true,
          recentPlaced: true,
        };
        fixture.sessions.splice(fixture.sessions.indexOf(target), 1);
        expect(requests).toHaveLength(2);
        const knownAborts = failures.filter((failure) => {
          const path = new URL(failure.url).pathname;
          const knownNoContentPath =
            (failure.method === 'GET' && path === '/api/sessions/other-owner/plan') ||
            (failure.method === 'DELETE' && path === '/api/sessions/forget-owner');
          return (
            knownNoContentPath &&
            failure.errorText === 'net::ERR_ABORTED' &&
            failure.startedDuring !== null &&
            failure.responseStatus === 204 &&
            failure.responseOk === true &&
            failure.tag !== null &&
            witnesses.some(
              (witness) =>
                witness.kind === 'resolved' &&
                witness.id === failure.tag &&
                witness.url === failure.url &&
                witness.method === failure.method &&
                witness.status === 204 &&
                witness.ok === true &&
                witness.bodyUsed === false,
            )
          );
        });
        await testInfo.attach('request-failure-context', {
          body: JSON.stringify(
            { contexts, failures, knownAborts, witnesses, completionWitness },
            null,
            2,
          ),
          contentType: 'application/json',
        });
        expect(
          failures.filter((failure) => !knownAborts.includes(failure)),
          JSON.stringify(failures),
        ).toEqual([]);
        // Consume exact recorded abort occurrences, never a URL-wide exemption.
        const remainingAborts = [...knownAborts];
        const unexpectedRequests = diagnostics.requestFailures.filter((url) => {
          const index = remainingAborts.findIndex((failure) => failure.url === url);
          if (index < 0) return true;
          remainingAborts.splice(index, 1);
          return false;
        });
        expect(remainingAborts).toEqual([]);
        expectCleanThemeDiagnostics(
          { ...diagnostics, requestFailures: unexpectedRequests },
          {
            expectedConsoleErrors: [
              'Failed to load resource: the server responded with a status of 503 (Service Unavailable)',
              'Failed to load resource: the server responded with a status of 404 (Not Found)',
            ],
          },
        );
      } finally {
        for (const pending of requests)
          pending.resolve({ status: 503, body: { code: 'SESSION_FORGET_FAILED' } });
        await Promise.allSettled(routeSettlements);
        await testInfo.attach('fetch-resolution-witnesses', {
          body: JSON.stringify({ witnesses, failures, completionWitness }, null, 2),
          contentType: 'application/json',
        });
      }
    });
  }
}
