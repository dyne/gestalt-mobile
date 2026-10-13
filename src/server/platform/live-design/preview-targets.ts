/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

export type RegisteredPreviewTarget = Readonly<{
  appRoot: string;
  appPort: number;
  helperPort: number;
  gatewayPort: number;
}>;
export function loopbackPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('LIVE_TARGET_INVALID');
  return port;
}

/** Trusted composition/owned process admission only. Public operations select opaque IDs. */
export class RegisteredPreviewTargets {
  private readonly registrations = new Map<string, RegisteredPreviewTarget>();
  register(target: RegisteredPreviewTarget): string {
    const registered = Object.freeze({
      appRoot: realpathSync(target.appRoot),
      appPort: loopbackPort(target.appPort),
      helperPort: loopbackPort(target.helperPort),
      gatewayPort: loopbackPort(target.gatewayPort),
    });
    if (new Set([registered.appPort, registered.helperPort, registered.gatewayPort]).size !== 3)
      throw new Error('LIVE_TARGET_INVALID');
    const id = randomUUID();
    this.registrations.set(id, registered);
    return id;
  }
  read(id: string, canonicalAppRoot: string): RegisteredPreviewTarget {
    const target = this.registrations.get(id);
    if (!target || target.appRoot !== realpathSync(canonicalAppRoot))
      throw new Error('LIVE_TARGET_UNREGISTERED');
    return target;
  }
  unregister(id: string): void {
    this.registrations.delete(id);
  }
}
