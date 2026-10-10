/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import type {
  PreviewGrantDependencies,
  PreviewInstance,
  PreviewLease,
} from '../application/ports.js';
import { fail, leaseValid, previewOrigin } from '../application/grants.js';

export type PreviewRequest = {
  method: string;
  target: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  websocket: boolean;
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const instanceSchema = z.strictObject({
  relayId: id,
  appId: id,
  liveId: id,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previewOrigin: z.string(),
});
export function validatedPreviewInstance(
  value: PreviewInstance,
  mobileOrigin: string,
): Readonly<PreviewInstance> {
  const result = instanceSchema.safeParse(value);
  if (!result.success) return fail('LIVE_INVALID_REQUEST', 400);
  const canonical = previewOrigin(result.data.previewOrigin, mobileOrigin);
  if (canonical !== result.data.previewOrigin) return fail('LIVE_ORIGIN_MISMATCH', 421);
  return Object.freeze(result.data);
}
export function normalizedPreviewHeaders(
  headers: PreviewRequest['headers'],
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
      name in result ||
      typeof value !== 'string' ||
      /[\r\n\0]/.test(value)
    )
      return fail('LIVE_INVALID_REQUEST', 400);
    result[name] = value;
  }
  return result;
}
export function authorizePreviewRequest(
  deps: PreviewGrantDependencies,
  instance: Readonly<PreviewInstance>,
  request: PreviewRequest,
): PreviewLease {
  if (
    typeof request.websocket !== 'boolean' ||
    !['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ||
    (request.websocket && request.method !== 'GET')
  )
    return fail('LIVE_INVALID_REQUEST', 400);
  if (
    typeof request.target !== 'string' ||
    request.target.length > 4096 ||
    !request.target.startsWith('/') ||
    request.target.startsWith('//') ||
    /[\\\r\n\0#]/.test(request.target)
  )
    return fail('LIVE_INVALID_REQUEST', 400);
  let decoded: string;
  try {
    decoded = decodeURIComponent(request.target.split('?')[0]!);
  } catch {
    return fail('LIVE_INVALID_REQUEST', 400);
  }
  if (
    decoded.startsWith('//') ||
    /[\\\r\n\0]/.test(decoded) ||
    decoded.split('/').some((part) => part === '.' || part === '..')
  )
    return fail('LIVE_INVALID_REQUEST', 400);
  const headers = normalizedPreviewHeaders(request.headers);
  if (
    headers.upgrade !== undefined &&
    (!request.websocket || headers.upgrade.toLowerCase() !== 'websocket')
  )
    return fail('LIVE_INVALID_REQUEST', 400);
  if (headers.host !== new URL(instance.previewOrigin).host)
    return fail('LIVE_ORIGIN_MISMATCH', 421);
  if (headers.origin !== undefined && headers.origin !== instance.previewOrigin)
    return fail('ORIGIN_NOT_ALLOWED', 403);
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !request.websocket;
  if (!safe && headers.origin !== instance.previewOrigin) return fail('ORIGIN_NOT_ALLOWED', 403);
  const navigation =
    safe && headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document';
  // Browsers do not attach Fetch Metadata to WebSocket handshakes. Their exact
  // Origin was required above; this also denies sibling/cross-port upgrades.
  // HTTP non-navigation reads still require browser Fetch Metadata (ADR § isolation).
  const metadataRequired = !navigation && !request.websocket;
  if (
    (metadataRequired && headers['sec-fetch-site'] !== 'same-origin') ||
    (request.websocket &&
      headers['sec-fetch-site'] !== undefined &&
      headers['sec-fetch-site'] !== 'same-origin')
  )
    return fail('LIVE_CROSS_ORIGIN_REQUEST', 403);
  if (headers['sec-fetch-mode'] === 'navigate' && !navigation)
    return fail('LIVE_CROSS_ORIGIN_REQUEST', 403);
  const name = `__Host-gestalt_live_p${new URL(instance.previewOrigin).port || '443'}`;
  const cookies = (headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  const token = cookies.length === 1 ? cookies[0]!.slice(name.length + 1) : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return fail('LIVE_AUTH_REQUIRED', 401);
  const lease = deps.store.findLease(deps.secrets.hash(token));
  if (
    !lease ||
    lease.relayId !== instance.relayId ||
    lease.appId !== instance.appId ||
    lease.liveId !== instance.liveId ||
    lease.generation !== instance.generation ||
    !leaseValid(deps, lease, instance.previewOrigin, deps.now().toISOString())
  )
    return fail('LIVE_AUTH_REQUIRED', 401);
  return lease;
}
