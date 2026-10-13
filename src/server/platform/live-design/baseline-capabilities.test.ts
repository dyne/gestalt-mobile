/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { baselineHasNoManagedDelegates } from './baseline-capabilities.js';

it('avoids proposing unselected disabled transports only for an actual empty native baseline', () => {
  expect(
    baselineHasNoManagedDelegates({
      observed: { config: { mcp_servers: {} } },
      threadConfig: {},
      skills: [],
    }),
  ).toBe(true);
  for (const observed of [
    null,
    {},
    { config: {} },
    { config: null },
    { config: { mcp_servers: [] } },
    { config: { mcp_servers: { unknown: { enabled: false } } } },
  ])
    expect(baselineHasNoManagedDelegates({ observed, threadConfig: {}, skills: [] })).toBe(false);
  expect(
    baselineHasNoManagedDelegates({
      observed: { config: { mcp_servers: {} } },
      threadConfig: { mcp_servers: { unknown: { enabled: false } } },
      skills: [],
    }),
  ).toBe(false);
  expect(
    baselineHasNoManagedDelegates({
      observed: { config: { mcp_servers: {} } },
      threadConfig: { 'mcp_servers.unknown.enabled': false },
      skills: [],
    }),
  ).toBe(false);
  for (const name of ['gestalt:xerj', 'gestalt:serena'])
    expect(
      baselineHasNoManagedDelegates({
        observed: { config: { mcp_servers: {} } },
        threadConfig: {},
        skills: [{ name }],
      }),
    ).toBe(false);
});
