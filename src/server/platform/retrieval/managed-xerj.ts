/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseXerjStartupReason } from '../../../shared/contracts/xerj-startup.js';
import type {
  RetrievalCapability,
  RetrievalCapabilityPort,
} from '../../features/skills/application/ports.js';

/** The manager alone owns backend identity, authentication and shared lifetime. */
export class ManagedXerj implements RetrievalCapabilityPort {
  private startup?: { manager: string; result: Promise<RetrievalCapability> };
  private readonly probes = new Set<{ stop(): void; closed: Promise<void> }>();
  private closed = false;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async check(input: {
    cwd: string;
    deadline: number;
    start: boolean;
  }): Promise<RetrievalCapability> {
    if (this.closed) return { status: 'unavailable', reason: 'cancelled' };
    const manager = await this.manager();
    if (this.closed) return { status: 'unavailable', reason: 'cancelled' };
    if (!manager) return { status: 'absent' };
    const remaining = input.deadline - Date.now();
    if (this.startup?.manager === manager)
      return this.wait(this.startup.result, Math.max(0, remaining));
    // The shipped manager rejects sub-100ms operations because it reserves
    // cleanup time inside the overall deadline. Do not spend the remaining
    // budget spawning a request that cannot satisfy that contract.
    if (remaining < minimumXerjTimeoutMs)
      return { status: 'unavailable', reason: 'readiness-timeout' };
    // A short-lived session waiter never owns the shared startup process.
    // Read-only discovery can observe an existing startup but cannot initiate one.
    if (!input.start)
      return this.run(manager, input.cwd, 'probe', Math.min(remaining, maximumXerjTimeoutMs));
    const startup = {
      manager,
      result: this.run(manager, input.cwd, 'ensure-ready', xerjStartupTimeout(this.environment)),
    };
    this.startup = startup;
    void startup.result.then(() => {
      if (this.startup === startup) this.startup = undefined;
    });
    return this.wait(startup.result, remaining);
  }

  private async wait(
    result: Promise<RetrievalCapability>,
    timeout: number,
  ): Promise<RetrievalCapability> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        result,
        new Promise<RetrievalCapability>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'starting' }), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private run(
    manager: string,
    cwd: string,
    operation: 'probe' | 'ensure-ready',
    timeout: number,
  ): Promise<RetrievalCapability> {
    return new Promise<RetrievalCapability>((resolve) => {
      const child = spawn(manager, ['xerj', operation], {
        cwd,
        env: { ...this.environment, XERJ_READY_TIMEOUT_MS: String(timeout) },
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      let finished = false;
      let failure: RetrievalCapability | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let closed!: () => void;
      const probe = {
        stop: () => stop('cancelled'),
        closed: new Promise<void>((resolve) => {
          closed = resolve;
        }),
      };
      this.probes.add(probe);
      const settle = (result: RetrievalCapability) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        clearTimeout(escalation);
        this.probes.delete(probe);
        closed();
        resolve(result);
      };
      const unavailable = (reason: string): RetrievalCapability => ({
        status: 'unavailable',
        reason,
      });
      const stop = (reason: string) => {
        if (finished || failure) return;
        failure = unavailable(reason);
        // Reap only our manager client; its lifecycle contract owns launch cleanup.
        child.kill('SIGTERM');
        escalation = setTimeout(() => child.kill('SIGKILL'), 100).unref();
      };
      const timer = setTimeout(() => stop('readiness-timeout'), timeout);
      child.on('error', () => {
        failure = unavailable('manager-unavailable');
      });
      child.stdout.on('data', (data: Buffer) => {
        if (failure) return;
        output += data.toString();
        if (output.length > 16_384) {
          stop('invalid-manager-response');
        }
      });
      child.once('close', (code) => {
        if (failure) return settle(failure);
        try {
          const value = JSON.parse(output);
          if (code !== 0 || value.schemaVersion !== 1) throw new Error();
          if (value.status === 'absent') return settle({ status: 'absent' });
          if (value.status === 'unavailable')
            return settle(unavailable(parseXerjStartupReason(value.reason)));
          if (
            value.status !== 'ready' ||
            typeof value.version !== 'string' ||
            !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.version) ||
            typeof value.endpoint !== 'string' ||
            !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(value.endpoint)
          )
            throw new Error();
          const url = new URL(value.endpoint);
          if (Number(url.port || 80) < 1 || Number(url.port || 80) > 65535) throw new Error();
          settle({ status: 'ready', manager, endpoint: value.endpoint });
        } catch {
          settle(unavailable('invalid-manager-response'));
        }
      });
    }).catch(() => ({ status: 'unavailable', reason: 'manager-unavailable' }));
  }

  async close(): Promise<void> {
    this.closed = true;
    const probes = [...this.probes];
    for (const probe of probes) probe.stop();
    await Promise.all(probes.map((probe) => probe.closed));
  }

  private async manager(): Promise<string | undefined> {
    const explicit = this.environment.GESTALT_MANAGER_BIN;
    const paths = explicit
      ? [explicit]
      : (this.environment.PATH ?? '')
          .split(':')
          .filter(Boolean)
          .map((path) => join(path, 'gestalt'));
    for (const path of paths) {
      if (!isAbsolute(path)) continue;
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* Try next established executable path. */
      }
    }
    return undefined;
  }
}

export function xerjDeadline(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.XERJ_READY_TIMEOUT_MS);
  return (
    Date.now() +
    (Number.isInteger(configured) &&
    configured >= minimumXerjTimeoutMs &&
    configured <= maximumXerjTimeoutMs
      ? configured
      : defaultXerjTimeoutMs)
  );
}

const minimumXerjTimeoutMs = 100;
const maximumXerjTimeoutMs = 60_000;
const defaultXerjTimeoutMs = 5_000;

export function xerjStartupTimeout(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.XERJ_STARTUP_TIMEOUT_MS);
  return Number.isInteger(configured) &&
    configured >= minimumXerjTimeoutMs &&
    configured <= maximumXerjTimeoutMs
    ? configured
    : 30_000;
}
