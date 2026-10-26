/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import { parseToolEfficiencySnapshot } from './tool-efficiency.js';
import { efficiencyFixture } from './tool-efficiency.test-fixture.js';

it('preserves known zero and partial measurements while dropping unknown payload fields', () => {
  const fixture = efficiencyFixture();
  const input = {
    ...fixture,
    privateOutput: 'secret',
    groups: fixture.groups.map((group) => ({
      ...group,
      command: 'private',
      durationMs: { ...group.durationMs, output: 'secret' },
    })),
  };
  expect(parseToolEfficiencySnapshot(input, 'session')).toEqual(fixture);
  expect(JSON.stringify(parseToolEfficiencySnapshot(input, 'session'))).not.toMatch(
    /secret|private/,
  );
});
it('rejects foreign sessions, missing revisions and unbounded or contradictory data', () => {
  const fixture = efficiencyFixture();
  expect(parseToolEfficiencySnapshot(fixture, 'other')).toBeNull();
  expect(
    parseToolEfficiencySnapshot(
      { ...fixture, groups: [fixture.groups[0], fixture.groups[0]] },
      'session',
    ),
  ).toBeNull();
  for (const input of [
    null,
    { ...fixture, revision: undefined },
    { ...fixture, revision: -1 },
    { ...fixture, groups: Array(65).fill(fixture.groups[0]) },
    { ...fixture, observedAt: 'not a timestamp' },
    {
      ...fixture,
      groups: [
        { ...fixture.groups[0], durationMs: { value: 0, measuredCalls: 0, coverage: 'complete' } },
      ],
    },
    {
      ...fixture,
      groups: [
        {
          ...fixture.groups[0],
          completeness: {
            ...fixture.groups[0].completeness,
            capture: { complete: 2, partial: 0, unknown: 0, missing: 0 },
          },
        },
      ],
    },
  ])
    expect(parseToolEfficiencySnapshot(input, 'session')).toBeNull();
});
