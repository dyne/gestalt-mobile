/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';

import type { SkillSelection } from '../../features/skills/model/skill-profile.js';
import { KimiWebClient } from './kimi-web-client.js';
import { boundMessage } from './kimi-errors.js';
import { prepareKimiShareDir } from './kimi-share-dir.js';
import { materializeKimiSkillsDir } from './kimi-skills-materializer.js';

export type KimiServerHandle = {
  profileKey: string;
  baseUrl: string;
  token: string;
  shareDir: string;
  skillsDir: string;
  client: KimiWebClient;
};

type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; stdio: 'pipe' },
) => ChildProcessWithoutNullStreams;

const READINESS_TIMEOUT_MS = 15_000;
const READINESS_POLL_MS = 100;
const LOG_TAIL_BYTES = 4 * 1024;
const BASE_PORT = 58627;

type ManagedServer = {
  profileKey: string;
  fingerprint: string;
  child: ChildProcessWithoutNullStreams;
  handle: KimiServerHandle;
  exitListeners: Set<() => void>;
  exited: boolean;
  logTail: string;
};

/**
 * Owns one gestalt-dedicated `kimi web` process per skill profile. Each
 * process gets an isolated `KIMI_SHARE_DIR` (auth material symlinked from the
 * user's real kimi home) whose copied `config.toml` gestalt patches with the
 * profile's materialized skills directory via `POST /api/v1/config`.
 */
export class KimiWebServerManager {
  private readonly servers = new Map<string, ManagedServer>();

  public constructor(
    private readonly input: {
      stateBase: string;
      sourceShareDir: string;
      command?: string;
      spawnImpl?: SpawnFn;
      fetchImpl?: typeof fetch;
      startPort?: number;
    },
  ) {}

  /** Returns the running (or freshly started) server for a profile key. */
  public async ensure(profileKey: string, selection: SkillSelection): Promise<KimiServerHandle> {
    const fingerprint = JSON.stringify(selection);
    const existing = this.servers.get(profileKey);
    if (existing && !existing.exited && existing.fingerprint === fingerprint) {
      return existing.handle;
    }
    if (existing) await this.stop(profileKey);
    return this.spawn(profileKey, fingerprint, selection);
  }

  public get(profileKey: string): KimiServerHandle | null {
    const server = this.servers.get(profileKey);
    return server && !server.exited ? server.handle : null;
  }

  public onServerExit(profileKey: string, listener: () => void): () => void {
    const server = this.servers.get(profileKey);
    if (!server) return () => {};
    server.exitListeners.add(listener);
    return () => server.exitListeners.delete(listener);
  }

  public async stop(profileKey: string): Promise<void> {
    const server = this.servers.get(profileKey);
    if (!server) return;
    this.servers.delete(profileKey);
    if (!server.exited) {
      server.child.kill('SIGTERM');
      await waitForExit(server.child, 3_000);
    }
    for (const listener of server.exitListeners) listener();
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((key) => this.stop(key)));
  }

  private async spawn(
    profileKey: string,
    fingerprint: string,
    selection: SkillSelection,
  ): Promise<KimiServerHandle> {
    const { shareDir, skillsDir } = prepareKimiShareDir({
      stateBase: this.input.stateBase,
      profileKey,
      sourceShareDir: this.input.sourceShareDir,
    });
    materializeKimiSkillsDir(skillsDir, selection);
    const port = await pickFreePort(this.input.startPort ?? BASE_PORT);
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = (this.input.spawnImpl ?? (spawn as SpawnFn))(
      this.input.command ?? 'kimi',
      ['web', '--no-open', '--port', String(port)],
      {
        cwd: shareDir,
        env: kimiChildEnvironment({ KIMI_SHARE_DIR: shareDir }),
        shell: false,
        stdio: 'pipe',
      },
    );

    const server: ManagedServer = {
      profileKey,
      fingerprint,
      child,
      handle: {
        profileKey,
        baseUrl,
        token: '',
        shareDir,
        skillsDir,
        client: new KimiWebClient(baseUrl, '', this.input.fetchImpl),
      },
      exitListeners: new Set(),
      exited: false,
      logTail: '',
    };
    this.servers.set(profileKey, server);

    try {
      server.handle.token = await waitForServerReady(server);
      server.handle.client = new KimiWebClient(baseUrl, server.handle.token, this.input.fetchImpl);
      // Publish the profile's materialized skills dir to this isolated server.
      await server.handle.client.post('/api/v1/config', { extra_skill_dirs: [skillsDir] });
    } catch (error) {
      await this.stop(profileKey);
      throw error;
    }
    child.once('exit', () => {
      server.exited = true;
      if (this.servers.get(profileKey) === server) this.servers.delete(profileKey);
      for (const listener of server.exitListeners) listener();
    });
    return server.handle;
  }
}

/** Prevents relay state from leaking into kimi web children, and pins KIMI_SHARE_DIR. */
export function kimiChildEnvironment(
  overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_URL;
  delete inherited.GESTALT_MOBILE_ORG_PLAN_MEASUREMENT_TOKEN;
  delete inherited.KIMI_SHARE_DIR;
  return { ...inherited, ...overrides };
}

async function pickFreePort(preferred: number): Promise<number> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (address && typeof address === 'object') return address.port;
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
  return preferred;
}

/** Watches the child until its token is printed and `/api/v1/meta` answers. */
async function waitForServerReady(server: ManagedServer): Promise<string> {
  const tokenPromise = new Promise<string>((resolve, reject) => {
    server.child.stdout.on('data', (chunk: Buffer) => {
      server.logTail = (server.logTail + chunk.toString('utf8')).slice(-LOG_TAIL_BYTES);
      const match = /^Token:\s+(\S+)\s*$/m.exec(server.logTail);
      if (match) resolve(match[1]);
    });
    server.child.once('exit', (code) => {
      reject(
        new Error(
          `kimi web exited before becoming ready (code ${code ?? 'signal'}): ${boundMessage(server.logTail).slice(-200)}`,
        ),
      );
    });
  });

  const timeout = setTimeout(() => {
    server.child.kill('SIGTERM');
  }, READINESS_TIMEOUT_MS);
  try {
    const token = await tokenPromise;
    const client = new KimiWebClient(server.handle.baseUrl, token);
    const deadline = Date.now() + READINESS_TIMEOUT_MS;
    for (;;) {
      try {
        await client.get('/api/v1/meta');
        return token;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await delay(READINESS_POLL_MS);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
