/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fastify from 'fastify';
import { expect, it } from 'vitest';
import { registerCheckReferences } from './endpoint.js';
it('checks deduplicated paths in bounded metadata batches without reading file contents', async () => {
  const app = fastify();
  let active = 0;
  let peak = 0;
  const checked: string[] = [];
  registerCheckReferences(app, {
    workspaces: { resolve: async () => ({ id: 'root', name: 'root', realPath: '/safe' }) },
    files: {
      list: async () => ({ kind: 'missing' }),
      read: async () => {
        throw new Error('must not read contents');
      },
      exists: async (root, path) => {
        expect(root).toBe('/safe');
        checked.push(path);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return path !== 'missing';
      },
    },
  });
  const paths = [
    'missing',
    ...Array.from({ length: 18 }, (_, i) => `docs/file-${i}`),
    'docs/file-0',
  ];
  const response = await app.inject({
    method: 'POST',
    url: '/api/workspaces/root/files/references',
    payload: { paths },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ paths: paths.slice(1, -1) });
  expect(checked).toHaveLength(19);
  expect(peak).toBeLessThanOrEqual(8);
  for (const paths of [null, [3], ['\0'], Array(65).fill('a'), ['a'.repeat(4097)]]) {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workspaces/root/files/references',
          payload: { paths },
        })
      ).statusCode,
    ).toBe(400);
  }
  await app.close();
});
