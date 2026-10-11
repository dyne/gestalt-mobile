/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  PreviewGrantDependencies,
  PreviewInstance,
} from '../../features/live-design/application/ports.js';
import {
  authorizePreviewRequest,
  normalizedPreviewHeaders,
  validatedPreviewInstance,
  type PreviewRequest,
} from '../../features/live-design/authorize/use-case.js';
import { fail } from '../../features/live-design/application/grants.js';
import {
  PreviewConnections,
  type OwnedPreviewConnection,
  type PreviewConnectionPermit,
} from './preview-connections.js';

/** Private in-process adapter: no public HTTP auth endpoint or client-selected instance metadata. */
export class PreviewProxyAuthorization {
  private readonly instance: Readonly<PreviewInstance>;
  constructor(
    private readonly deps: PreviewGrantDependencies,
    instance: PreviewInstance,
    private readonly connections: PreviewConnections,
  ) {
    this.instance = validatedPreviewInstance(instance, deps.mobileOrigin);
  }
  /** Caller supplies the actual listener/request, registers before connecting, and checks permit for every write. */
  open(
    request: PreviewRequest,
    connection: OwnedPreviewConnection,
  ): PreviewConnectionPermit & { upstreamHeaders: Readonly<Record<string, string>> } {
    try {
      const lease = authorizePreviewRequest(this.deps, this.instance, request);
      const permit = this.connections.open(lease, connection);
      if (!permit.active()) return fail('LIVE_AUTH_REQUIRED', 401);
      return {
        ...permit,
        upstreamHeaders: stripPreviewRequestHeaders(request.headers, this.instance),
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error) throw error;
      return fail('LIVE_AUTH_UNAVAILABLE', 503);
    }
  }
}
export function stripPreviewRequestHeaders(
  headers: PreviewRequest['headers'],
  instance: Readonly<PreviewInstance>,
): Readonly<Record<string, string>> {
  const normalized = normalizedPreviewHeaders(headers);
  const result: Record<string, string> = Object.create(null);
  // An allowlist avoids unknown application/helper/control credentials as well as cookies.
  for (const name of [
    'accept',
    'accept-encoding',
    'accept-language',
    'content-type',
    'content-length',
    'range',
    'if-none-match',
    'if-modified-since',
    'user-agent',
    'sec-websocket-protocol',
  ])
    if (normalized[name] !== undefined) result[name] = normalized[name]!;
  result['x-gestalt-live-id'] = instance.liveId;
  result['x-gestalt-live-generation'] = String(instance.generation);
  return Object.freeze(result);
}
export function stripPreviewResponseHeaders(
  headers: Readonly<Record<string, string | string[] | number | undefined>>,
): Record<string, string | string[] | number> {
  const result: Record<string, string | string[] | number> = Object.create(null);
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (
      value === undefined ||
      name === 'set-cookie' ||
      name === 'set-cookie2' ||
      name === 'authorization' ||
      name === 'proxy-authenticate' ||
      name === 'www-authenticate' ||
      name === 'connection' ||
      name === 'transfer-encoding' ||
      name.startsWith('access-control-') ||
      name.startsWith('x-gestalt-') ||
      name.startsWith('x-forwarded-') ||
      name === 'forwarded'
    )
      continue;
    result[name] = value;
  }
  const policy = result['content-security-policy'];
  result['content-security-policy'] = [
    ...(Array.isArray(policy) ? policy : typeof policy === 'string' ? [policy] : []),
    "frame-ancestors 'none'",
  ];
  result['cross-origin-resource-policy'] = 'same-origin';
  result['cache-control'] = 'no-store';
  result['referrer-policy'] = 'no-referrer';
  return result;
}
