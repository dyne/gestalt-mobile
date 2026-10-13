/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import type { AppIdentity } from '../../features/live-design/application/ownership.js';
import { liveAppIdentity, revalidateLiveApp } from './sqlite-live-ownership.js';
import { loopbackPort } from './preview-targets.js';

export type DevServerIdentity = Readonly<{
  pid: number;
  startTicks: string;
  executableDigest: string;
  socketInodes: readonly string[];
}>;
export type RegisteredDevServer = Readonly<{
  targetId: string;
  app: AppIdentity;
  port: number;
  identity: DevServerIdentity;
}>;

/** Linux listener identity, including the owning process start fence; a port/PID alone is insufficient. */
export function observeLoopbackListener(pid: number, port: number): DevServerIdentity {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
    const processRoot = `/proc/${pid}`;
    const stat = readFileSync(`${processRoot}/stat`, 'utf8');
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) throw new Error();
    const executableDigest = createHash('sha256')
      .update(readFileSync(`${processRoot}/exe`))
      .digest('hex');
    const sockets = new Set<string>();
    for (const fd of readdirSync(`${processRoot}/fd`)) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`${processRoot}/fd/${fd}`));
        if (match) sockets.add(match[1]!);
      } catch {
        /* An unrelated descriptor may close while observing. */
      }
    }
    const socketInodes: string[] = [];
    for (const protocol of ['tcp', 'tcp6']) {
      const rows = readFileSync(`${processRoot}/net/${protocol}`, 'utf8')
        .trim()
        .split('\n')
        .slice(1);
      for (const row of rows) {
        const fields = row.trim().split(/\s+/);
        const [address, encodedPort] = fields[1]!.split(':');
        if (
          fields[3] !== '0A' ||
          Number.parseInt(encodedPort!, 16) !== port ||
          !sockets.has(fields[9]!)
        )
          continue;
        if (address !== '0100007F' && address !== '00000000000000000000000001000000')
          throw new Error();
        socketInodes.push(fields[9]!);
      }
    }
    if (socketInodes.length === 0) throw new Error();
    // Fence PID reuse during observation itself.
    const after = readFileSync(`${processRoot}/stat`, 'utf8');
    if (after.slice(after.lastIndexOf(')') + 2).split(' ')[19] !== startTicks) throw new Error();
    return Object.freeze({
      pid,
      startTicks,
      executableDigest,
      socketInodes: Object.freeze(socketInodes.sort()),
    });
  } catch {
    throw new Error('LIVE_TARGET_UNREGISTERED');
  }
}

/** Trusted process/registry admission only; never a public arbitrary-URL registration or kill authority. */
export class RegisteredDevServers {
  private readonly targets = new Map<string, RegisteredDevServer>();
  register(appRoot: string, port: number, pid: number): RegisteredDevServer {
    const app = Object.freeze(liveAppIdentity(appRoot));
    const target = Object.freeze({
      targetId: randomUUID(),
      app,
      port: loopbackPort(port),
      identity: observeLoopbackListener(pid, port),
    });
    this.targets.set(target.targetId, target);
    return target;
  }
  read(targetId: string, app: AppIdentity): RegisteredDevServer {
    const target = this.targets.get(targetId);
    if (
      !target ||
      target.app.canonicalAppRoot !== app.canonicalAppRoot ||
      target.app.device !== app.device ||
      target.app.inode !== app.inode
    )
      throw new Error('LIVE_TARGET_UNREGISTERED');
    revalidateLiveApp(target.app);
    if (
      JSON.stringify(observeLoopbackListener(target.identity.pid, target.port)) !==
      JSON.stringify(target.identity)
    )
      throw new Error('LIVE_TARGET_UNREGISTERED');
    return target;
  }
  /** Only forget a registration. External dev servers are never terminated. */
  unregister(targetId: string): void {
    this.targets.delete(targetId);
  }
}
