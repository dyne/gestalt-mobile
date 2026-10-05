/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect, it } from 'vitest';
import { jsonBranches, jsonRows } from './json-tree.js';
it('shows only root members by default and expands every object and array without key collisions', () => {
  const value = { config: { nested: [1, { value: true }] }, 'config/nested': null, empty: {} };
  const folded = jsonRows(value, new Set(['']));
  expect(folded.map((row) => row.text)).toEqual([
    '{',
    '"config": { … 1 keys },',
    '"config/nested": null,',
    '"empty": {}',
    '}',
  ]);
  const all = jsonRows(value, jsonBranches(value));
  expect(all.some((row) => row.text === '"value": true')).toBe(true);
  expect(new Set(all.map((row) => row.id)).size).toBe(all.length);
});
it('renders scalar JSON and deeply nested branches without recursive traversal', () => {
  expect(jsonRows('hello', new Set())[0]?.text).toBe('"hello"');
  let value: unknown = 1;
  for (let i = 0; i < 2000; i++) value = { child: value };
  expect(jsonRows(value, jsonBranches(value))).toHaveLength(4001);
});
