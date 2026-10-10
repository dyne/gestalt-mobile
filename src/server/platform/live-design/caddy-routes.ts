/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type {
  LivePreviewRoutes,
  PreviewOriginAssignment,
} from '../../features/live-design/application/routes.js';
import { UnixCaddyAdmin } from './caddy-admin.js';
import { CaddyRouteStore, type StoredCaddyRoute } from './caddy-route-store.js';
import { RegisteredPreviewTargets } from './preview-targets.js';

/** Internal engine for a trusted controller/broker; no raw config API is exposed to projects. */
export class CaddyRoutes implements LivePreviewRoutes {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly admin: UnixCaddyAdmin,
    private readonly store: CaddyRouteStore,
    private readonly targets: RegisteredPreviewTargets,
  ) {}
  activate(appRoot: string, registrationId: string): Promise<PreviewOriginAssignment> {
    return this.serialize(async () => {
      const target = this.targets.read(registrationId, appRoot);
      const assignment = this.store.assign(target.appRoot);
      const proxy = () => ({
        handler: 'reverse_proxy',
        upstreams: [{ dial: `127.0.0.1:${target.gatewayPort}` }],
        flush_interval: -1,
        stream_timeout: 60_000_000_000,
        headers: {
          request: {
            delete: ['Forwarded', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Gestalt-*'],
          },
        },
      });
      this.store.desire(
        target.appRoot,
        {
          '@id': assignment.serverId,
          listen: [`:${assignment.port}`],
          tls_connection_policies: [{}],
          automatic_https: { disable_redirects: true },
          routes: [
            {
              '@id': `${assignment.serverId}_helper`,
              match: [{ host: [this.store.hostname], path: ['/__gestalt_live/*'] }],
              handle: [proxy()],
              terminal: true,
            },
            {
              '@id': `${assignment.serverId}_app`,
              match: [{ host: [this.store.hostname] }],
              handle: [proxy()],
              terminal: true,
            },
          ],
        },
        registrationId,
      );
      await this.sync(this.store.read(target.appRoot)!);
      const { canonicalAppRoot, origin, port, serverId } = assignment;
      return { canonicalAppRoot, origin, port, serverId };
    });
  }
  remove(appRoot: string): Promise<void> {
    return this.serialize(async () => {
      // Recovery must still remove an assigned route after its application directory disappeared.
      const canonical = this.store.read(appRoot) ? appRoot : realpathSync(appRoot);
      if (!this.store.read(canonical)) return;
      this.store.desire(canonical, null);
      await this.sync(this.store.read(canonical)!);
    });
  }
  reconcile(): Promise<void> {
    return this.serialize(async () => {
      for (const row of this.store.list()) await this.sync(row);
    });
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }
  private async sync(row: StoredCaddyRoute): Promise<void> {
    const desired = row.desired === null ? null : JSON.parse(row.desired);
    const applied = row.applied === null ? null : JSON.parse(row.applied);
    if (desired) this.targets.read(row.registrationId ?? '', row.canonicalAppRoot);
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.admin.request('GET', '/config/apps/http/servers');
      if (
        snapshot.status !== 200 ||
        !snapshot.etag ||
        !snapshot.body ||
        Array.isArray(snapshot.body) ||
        typeof snapshot.body !== 'object'
      )
        throw new Error('LIVE_CADDY_BOOTSTRAP_MISSING');
      const servers = snapshot.body as Record<string, Record<string, unknown>>;
      const current = servers[row.serverId];
      if (
        current !== undefined &&
        !isDeepStrictEqual(current, desired) &&
        !isDeepStrictEqual(current, applied)
      )
        throw new Error('LIVE_CADDY_OWNERSHIP_CONFLICT');
      if (
        desired &&
        Object.entries(servers).some(
          ([id, server]) =>
            id !== row.serverId &&
            (!Array.isArray(server.listen) ||
              server.listen.some(
                (listener) =>
                  typeof listener !== 'string' ||
                  listener.includes('/') ||
                  listenerPortConflict(listener, row.port),
              )),
        )
      )
        throw new Error('LIVE_PREVIEW_PORT_CONFLICT');
      if ((!desired && current === undefined) || isDeepStrictEqual(current, desired)) {
        this.store.acknowledge(row.canonicalAppRoot, row.desired);
        return;
      }
      const reply = await this.admin.request(
        desired === null ? 'DELETE' : current === undefined ? 'PUT' : 'PATCH',
        `/config/apps/http/servers/${row.serverId}`,
        snapshot.etag,
        desired ?? undefined,
      );
      if (reply.status === 412) continue;
      if (reply.status !== 200) throw new Error('LIVE_CADDY_UPDATE_FAILED');
      this.store.acknowledge(row.canonicalAppRoot, row.desired);
      return;
    }
    throw new Error('LIVE_CADDY_CONFLICT_RETRIES_EXHAUSTED');
  }
}

function listenerPortConflict(listener: string, port: number): boolean {
  const match = /:(\d+)(?:-(\d+))?$/.exec(listener);
  if (!match) return true; // Unknown address forms stay unavailable, rather than guessing free.
  return port >= Number(match[1]) && port <= Number(match[2] ?? match[1]);
}
