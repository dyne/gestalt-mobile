/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LiveAudience, PreviewGrantDependencies, PreviewLease } from './ports.js';

export class LiveAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export function fail(code: string, status: number): never {
  throw new LiveAuthError(code, status);
}
export function previewOrigin(value: string, mobileOrigin: string): string {
  const origin = new URL(value);
  const mobile = new URL(mobileOrigin);
  if (
    origin.protocol !== 'https:' ||
    mobile.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    mobile.username ||
    mobile.password ||
    mobile.pathname !== '/' ||
    mobile.search ||
    mobile.hash
  )
    return fail('LIVE_ORIGIN_MISMATCH', 421);
  if (origin.hostname === mobile.hostname) return fail('LIVE_PREVIEW_HOST_CONFLICT', 400);
  return origin.origin;
}
export function sameAudience(left: LiveAudience, right: LiveAudience): boolean {
  return (
    left.relayId === right.relayId &&
    left.appId === right.appId &&
    left.liveId === right.liveId &&
    left.generation === right.generation &&
    left.previewOrigin === right.previewOrigin &&
    left.authSessionHash === right.authSessionHash &&
    left.deviceId === right.deviceId
  );
}
export function currentAudience(
  deps: PreviewGrantDependencies,
  audience: LiveAudience,
  now: string,
): boolean {
  const current = deps.owners.read(audience.relayId);
  return (
    current !== null &&
    current.active &&
    sameAudience(current, audience) &&
    deps.authentication.authorized(audience.authSessionHash, audience.deviceId, now)
  );
}
export function owner(
  deps: PreviewGrantDependencies,
  cookie: string | undefined,
  relayId: string,
  liveId?: string,
  generation?: number,
): LiveAudience {
  const identity = deps.authentication.identity(cookie, deps.now().toISOString());
  if (!identity) return fail('AUTH_REQUIRED', 401);
  const current = deps.owners.read(relayId);
  if (
    !current ||
    current.authSessionHash !== identity.authSessionHash ||
    current.deviceId !== identity.deviceId
  )
    return fail('LIVE_NOT_FOUND', 404);
  if (!current.active) return fail('LIVE_NOT_ACTIVE', 409);
  if (liveId !== undefined && liveId !== current.liveId) return fail('LIVE_NOT_FOUND', 404);
  if (generation !== undefined && generation !== current.generation)
    return fail('LIVE_GENERATION_STALE', 409);
  previewOrigin(current.previewOrigin, deps.mobileOrigin);
  return current;
}
export function limit(deps: PreviewGrantDependencies, key: string): void {
  if (!deps.store.attempt(key, deps.now().getTime())) fail('LIVE_RATE_LIMITED', 429);
}
export function leaseValid(
  deps: PreviewGrantDependencies,
  lease: PreviewLease,
  origin: string,
  now: string,
): boolean {
  return (
    lease.previewOrigin === origin &&
    now < lease.leaseExpiresAt &&
    now < lease.absoluteExpiresAt &&
    currentAudience(deps, lease, now) &&
    deps.now().toISOString() < lease.leaseExpiresAt &&
    deps.now().toISOString() < lease.absoluteExpiresAt
  );
}
export function leaseDeadlines(lease: PreviewLease) {
  return { leaseExpiresAt: lease.leaseExpiresAt, absoluteExpiresAt: lease.absoluteExpiresAt };
}
