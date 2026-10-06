/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { DebugContext, SelfDebugSession } from '../../../shared/contracts/self-debug.js';
import { exportControlPlaneTrace } from '../../features/control-plane-trace/export-trace.js';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';
import { z } from 'zod';
import {
  thinkingLevels,
  type ThinkingLevel,
} from '../../../shared/contracts/session-model-settings.js';

const exec = promisify(execFile);
const repositories = ['gestalt', 'gestalt-mobile', 'gestalt-agents'] as const;

/** Reads only execution settings; executor role instructions do not belong to a root thread. */
export function executorSettings(source: string): SelfDebugSession['agent'] {
  const scalar = (key: string) =>
    source.match(new RegExp(`^${key}\\s*=\\s*["']([a-zA-Z0-9_.-]+)["']\\s*(?:#.*)?$`, 'm'))?.[1];
  const model = scalar('model');
  const reasoningEffort = scalar('model_reasoning_effort');
  if (!model || (reasoningEffort && !thinkingLevels.includes(reasoningEffort as ThinkingLevel)))
    throw new Error('DEBUG_EXECUTOR_CONFIGURATION_INVALID');
  return {
    name: 'org-plan-executor',
    model,
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as ThinkingLevel } : {}),
  };
}

export class SelfDebugWorkspace {
  private preparing: Promise<string> | null = null;
  constructor(
    private readonly root: string,
    private readonly executorProfile: string,
    private readonly databasePath: string,
  ) {}

  async settings(): Promise<SelfDebugSession['agent']> {
    return executorSettings(await readFile(this.executorProfile, 'utf8'));
  }

  prepare(): Promise<string> {
    this.preparing ??= this.prepareRepositories().catch((error: unknown) => {
      this.preparing = null;
      throw error;
    });
    return this.preparing;
  }

  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('DEBUG_WORKSPACE_UNSAFE');
  }

  private async prepareRepositories(): Promise<string> {
    await this.directory(this.root);
    const root = await realpath(this.root);
    // No updates or resets of existing clones: another debug session may be editing them.
    for (const name of repositories) {
      const destination = join(root, name);
      let exists = false;
      try {
        const info = await lstat(destination);
        exists = true;
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('DEBUG_REPOSITORY_UNSAFE');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!exists)
        await exec('git', ['clone', '--', `https://github.com/dyne/${name}.git`, destination], {
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        });
      const origin = await exec('git', ['-C', destination, 'remote', 'get-url', 'origin'], {
        timeout: 10_000,
      });
      if (
        !new RegExp(
          `^(?:https://github\\.com/dyne/|git@github\\.com:dyne/)${name}(?:\\.git)?$`,
        ).test(origin.stdout.trim())
      )
        throw new Error('DEBUG_REPOSITORY_ORIGIN_INVALID');
    }
    await this.directory(join(root, 'traces'));
    return root;
  }

  async capture(
    id: string,
    context: DebugContext,
    agent: SelfDebugSession['agent'],
  ): Promise<{ root: string; debug: SelfDebugSession }> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('DEBUG_ID_INVALID');
    // Capture before network activity to preserve the incident's original boundary.
    const trace = exportControlPlaneTrace(
      this.databasePath,
      context.mobileSession,
      context.capturedAt,
    );
    await this.directory(this.root);
    const root = await realpath(this.root);
    await this.directory(join(root, 'traces'));
    const tracePath = `traces/${id}.json`;
    await writeFile(
      join(root, tracePath),
      JSON.stringify(
        { ...trace, context, eventLimit: 5000, sourceAgent: { status: 'unavailable' } },
        null,
        2,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    return { root, debug: { context, tracePath, agent } };
  }

  async readTrace(debug: SelfDebugSession): Promise<string> {
    if (!/^traces\/[a-zA-Z0-9-]+\.json$/.test(debug.tracePath))
      throw new Error('DEBUG_TRACE_INVALID');
    const path = join(this.root, debug.tracePath);
    const root = await realpath(this.root);
    const traces = await realpath(join(this.root, 'traces'));
    if (traces !== join(root, 'traces') || (await realpath(path)) !== join(root, debug.tracePath))
      throw new Error('DEBUG_TRACE_INVALID');
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
      throw new Error('DEBUG_TRACE_INVALID');
    return readFile(path, 'utf8');
  }

  async askSource(
    id: string,
    source: RelaySessionSnapshot,
    debug: SelfDebugSession,
    ask: (prompt: string) => Promise<void>,
  ): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('DEBUG_ID_INVALID');
    const responsePath = join(source.workspacePath, '.gestalt', 'self-debug', `${id}.json`);
    const prompt = [
      'The user requested a Gestalt Self DEBUG session. A redacted relay trace has already been captured.',
      `If possible, write your diagnostic observations as JSON to ${responsePath}. Create the parent directory if necessary.`,
      'Use only this schema: {"candidateBoundary":"unknown|mobile|codex|agents|browser|sandbox", "reproducible":false, "observedEventTypes":["autopilot.turn-failed"], "errorCodes":["ERROR_CODE"]}. Select one candidateBoundary value, use a boolean for reproducible, and replace the example event types/codes with observed ones.',
      'Include no secrets, environment values, prompts, model output, or conversation. Do not stop, restart, or change the original task. If you cannot safely provide observations, continue the original task.',
    ].join('\n');
    let result: { status: string; observations?: unknown } = { status: 'unavailable' };
    const schema = z
      .object({
        candidateBoundary: z.enum(['unknown', 'mobile', 'codex', 'agents', 'browser', 'sandbox']),
        reproducible: z.boolean(),
        observedEventTypes: z
          .array(z.string().regex(/^(?:org-plan|autopilot|agent|session)\.[a-z.-]{1,80}$/))
          .max(30),
        errorCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,80}$/)).max(30),
      })
      .strict();
    try {
      await Promise.race([
        ask(prompt),
        delay(2000).then(() => {
          throw new Error('DEBUG_SOURCE_TIMEOUT');
        }),
      ]);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        try {
          const info = await lstat(responsePath);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) break;
          const resolved = await realpath(responsePath);
          if (resolved !== responsePath) break;
          const parsed = schema.safeParse(JSON.parse(await readFile(responsePath, 'utf8')));
          if (parsed.success) {
            result = { status: 'received', observations: parsed.data };
            break;
          }
        } catch {
          /* The agent may still be writing its response. */
        }
        await delay(250);
      }
    } catch {
      /* A failed source agent cannot block the independent debug session. */
    }
    const trace = JSON.parse(await this.readTrace(debug)) as Record<string, unknown>;
    await writeFile(
      join(this.root, debug.tracePath),
      JSON.stringify({ ...trace, sourceAgent: result }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}
