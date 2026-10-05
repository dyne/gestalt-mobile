/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RelaySessionSnapshot } from '../../features/sessions/model/relay-session.js';

/** Finds root assignments without treating instruction strings or TOML tables as settings. */
function replaceRootSetting(profile: string, key: string, value: string): string {
  const lines = profile.split('\n');
  let stringDelimiter: string | null = null;
  let rootEnd = lines.length;
  const assignments: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!stringDelimiter) {
      if (/^\s*\[/.test(line)) {
        rootEnd = index;
        break;
      }
      if (new RegExp(`^\\s*${key}\\s*=`).test(line)) assignments.push(index);
    }
    for (let offset = 0; offset < line.length; offset += 1) {
      const character = line[offset];
      if (stringDelimiter) {
        if (stringDelimiter.startsWith('"') && character === '\\') {
          offset += 1;
        } else if (line.startsWith(stringDelimiter, offset)) {
          offset += stringDelimiter.length - 1;
          stringDelimiter = null;
        }
      } else if (character === '#') {
        break;
      } else if (character === '"' || character === "'") {
        stringDelimiter = line.startsWith(character.repeat(3), offset)
          ? character.repeat(3)
          : character;
        offset += stringDelimiter.length - 1;
      }
    }
    if (stringDelimiter?.length === 1) throw new Error('ORG_EXECUTOR_PROFILE_INVALID');
  }
  if (stringDelimiter || assignments.length > 1) throw new Error('ORG_EXECUTOR_PROFILE_INVALID');
  const assignment = `${key} = ${JSON.stringify(value)}`;
  if (assignments.length) lines[assignments[0]!] = assignment;
  else lines.splice(rootEnd, 0, assignment);
  return lines.join('\n');
}

/** Keeps installed Org role instructions while pinning settings only for the owning session. */
export class SessionModelConfig {
  constructor(
    private readonly codexHome: string,
    private readonly stateDirectory: string,
  ) {}

  async resolve(session: RelaySessionSnapshot): Promise<Record<string, unknown>> {
    const settings = session.modelSettings;
    if (!settings) return {};
    const config: Record<string, unknown> = settings.reasoningEffort
      ? { model_reasoning_effort: settings.reasoningEffort }
      : {};
    if (!settings.executorModel && !settings.executorReasoningEffort) return config;
    let profile: string;
    try {
      profile = await readFile(join(this.codexHome, 'agents', 'org-plan-executor.toml'), 'utf8');
    } catch {
      throw new Error('ORG_EXECUTOR_PROFILE_UNAVAILABLE');
    }
    for (const [key, value] of [
      ['model', settings.executorModel],
      ['model_reasoning_effort', settings.executorReasoningEffort],
    ] as const) {
      if (!value) continue;
      profile = replaceRootSetting(profile, key, value);
    }
    const directory = join(this.stateDirectory, 'agent-profiles');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = createHash('sha256').update(session.id).digest('hex');
    const path = join(directory, `${name}.toml`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, profile, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return { ...config, agents: { 'org-plan-executor': { config_file: path } } };
  }
}
