/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';
describe('mapWithConcurrency', () => {
  it('runs every restoration task', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3], 2, async (value) => {
      seen.push(value);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('does not begin more restoration tasks than its configured limit', async () => {
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const complete = mapWithConcurrency([1, 2, 3], 2, async (value) => {
      started.push(value);
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    await Promise.resolve();
    expect(started).toHaveLength(2);
    releases.splice(0).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toHaveLength(3);
    releases.splice(0).forEach((release) => release());
    await complete;
  });
});
