/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi, onTestFinished } from 'vitest';
import {
  CodexAutoReset,
  resetCreditCooldownMs,
} from '../../features/catalog/application/codex-auto-reset.js';
import { registerCodexAutoReset } from '../../features/catalog/codex-auto-reset/endpoint.js';
import { SqliteCodexResetStore } from './sqlite-codex-reset-store.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'codex-auto-reset-'));
  onTestFinished(async () => rm(home, { recursive: true, force: true }));
  const store = new SqliteCodexResetStore(home);
  return { home, store };
}

it('defaults to off, validates the preference payload and shares the opt-in across relays', async () => {
  const { home, store } = await fixture();
  const app = Fastify();
  registerCodexAutoReset(app, store);
  onTestFinished(() => app.close());
  const url = '/api/codex/allowance/auto-reset';
  expect((await app.inject(url)).json()).toEqual({ enabled: false, resets: [] });
  expect(
    (await app.inject({ method: 'PUT', url, payload: { enabled: true, spend: true } })).statusCode,
  ).toBe(400);
  const account = { readCandidate: vi.fn(), redeem: vi.fn() };
  await new CodexAutoReset(store, () => 'unused').blocked(account);
  expect(account.readCandidate).not.toHaveBeenCalled();
  expect((await app.inject({ method: 'PUT', url, payload: { enabled: true } })).json()).toEqual({
    enabled: true,
    resets: [],
  });
  expect(new SqliteCodexResetStore(home).enabled()).toBe(true);
});

it('shares the durable cooldown and fences a stale weekly window even after a restart', async () => {
  const { home, store } = await fixture();
  const other = new SqliteCodexResetStore(home);
  store.setEnabled(true);
  let now = 1_800_000_000_000;
  const originalWindow = now / 1000 + 5_000;
  const account = {
    readCandidate: vi
      .fn()
      .mockResolvedValue({ creditId: 'credit', weeklyResetsAt: originalWindow }),
    redeem: vi.fn().mockResolvedValue(true),
  };
  const clock = () => now;
  const first = new CodexAutoReset(store, () => 'claim-one', clock);
  const second = new CodexAutoReset(other, () => 'claim-two', clock);
  account.redeem.mockImplementationOnce(async () => {
    now += 3_000;
    return true;
  });
  await Promise.all([first.blocked(account), first.blocked(account), second.blocked(account)]);
  expect(account.redeem).toHaveBeenCalledExactlyOnceWith('credit', 'claim-one');
  expect(other.status().resets).toEqual([{ id: 'claim-one', occurredAt: now }]);
  const restarted = new CodexAutoReset(new SqliteCodexResetStore(home), () => 'claim-three', clock);
  account.readCandidate.mockResolvedValue({
    creditId: 'next-credit',
    weeklyResetsAt: originalWindow + 1000,
  });
  now += resetCreditCooldownMs - 1;
  await restarted.blocked(account);
  expect(account.redeem).toHaveBeenCalledTimes(1);
  now += 1;
  account.readCandidate.mockResolvedValueOnce({
    creditId: 'credit',
    weeklyResetsAt: originalWindow,
  });
  await restarted.blocked(account);
  expect(account.redeem).toHaveBeenCalledTimes(1);
  await restarted.blocked(account);
  expect(account.redeem).toHaveBeenLastCalledWith('next-credit', 'claim-three');
  expect(other.status().resets.map((reset) => reset.id)).toEqual(['claim-three', 'claim-one']);
});

it('rechecks opt-in after the allowance read and never retries an unconfirmed redemption for the window', async () => {
  const { home, store } = await fixture();
  store.setEnabled(true);
  let now = 1_800_000_000_000;
  const candidate = { creditId: 'credit', weeklyResetsAt: now / 1000 + 5_000 };
  const clock = () => now;
  const account = {
    readCandidate: vi.fn(async () => {
      new SqliteCodexResetStore(home).setEnabled(false);
      return candidate;
    }),
    redeem: vi.fn().mockRejectedValue(new Error('response lost')),
  };
  const service = new CodexAutoReset(store, () => 'claim', clock);
  await service.blocked(account);
  expect(account.redeem).not.toHaveBeenCalled();
  store.setEnabled(true);
  account.readCandidate.mockResolvedValue(candidate);
  await service.blocked(account);
  now += resetCreditCooldownMs + 1;
  await new CodexAutoReset(store, () => 'retry', clock).blocked(account);
  expect(account.redeem).toHaveBeenCalledExactlyOnceWith('credit', 'claim');
  expect(store.status().resets).toEqual([]);
});
