/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FastifyInstance } from 'fastify';

export type PwaIcon = Readonly<{
  bytes: Buffer;
  contentType: 'image/png' | 'image/svg+xml';
  extension: 'png' | 'svg';
  sizes: string;
}>;

const manifestBase = {
  id: '/',
  name: 'Gestalt Mobile',
  short_name: 'Gestalt',
  description: 'A mobile interface for durable Codex development sessions.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#141414',
  theme_color: '#141414',
  categories: ['productivity', 'utilities'],
} as const;

export function pwaIconUrl(icon: PwaIcon): string {
  return `/install-icon.${icon.extension}`;
}

/** Overrides only install metadata; ordinary client assets stay package-static. */
export function registerPwaRoutes(app: FastifyInstance, icon: PwaIcon): void {
  const iconPath = pwaIconUrl(icon);
  app.get('/manifest.webmanifest', async (_request, reply) =>
    reply
      .header('Cache-Control', 'no-cache')
      .type('application/manifest+json')
      .send({
        ...manifestBase,
        icons: [
          {
            src: iconPath,
            sizes: icon.sizes,
            type: icon.contentType,
            purpose: 'any',
          },
        ],
      }),
  );
  app.get(iconPath, async (_request, reply) =>
    reply.header('Cache-Control', 'no-cache').type(icon.contentType).send(icon.bytes),
  );
}
