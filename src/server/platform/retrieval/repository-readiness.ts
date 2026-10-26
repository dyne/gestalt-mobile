/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { beforeDeadline } from './codex-xerj.js';
import { ReadinessEvidence } from './readiness-evidence.js';
import { hasUnrestrictedReadAuthority } from './read-authority.js';
import type { RetrievalReadiness } from '../../../shared/contracts/retrieval-readiness.js';

type Rpc = { request(method: string, params: unknown): Promise<unknown> };
type Notification = { method: string; params: unknown };
type Capture = {
  key: string;
  repository: NonNullable<RetrievalReadiness['repository']>;
  source: string;
  root: string;
  project: string;
  cwd: string;
  hasBuild: boolean;
  authorize(): void;
};
type Entry = { evidence: ReadinessEvidence; capture: Capture; threadId: string };
type Pending = {
  capture: Capture;
  entry: Entry;
  generation: string;
  tool: string;
  path: string;
  epoch: number;
};
const execute = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const small = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const contained = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

async function bytes(
  path: string,
  root: string,
  authorize: () => void,
  optional = false,
  limit = 4_194_304,
): Promise<Buffer | null> {
  try {
    authorize();
    const canonical = await realpath(path);
    if (!contained(root, canonical)) throw new Error('READINESS_PATH_OUTSIDE_WORKSPACE');
    authorize();
    const info = await stat(canonical);
    if (!info.isFile() || info.size > limit) throw new Error('READINESS_INPUT_TOO_LARGE');
    authorize();
    const content = await readFile(canonical);
    if (content.length > limit) throw new Error('READINESS_INPUT_TOO_LARGE');
    return content;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await execute('git', ['--no-optional-locks', ...args], {
      cwd,
      timeout: 2000,
      maxBuffer: 262144,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    })
  ).stdout;
}

/** Read only the requested source, known metadata and bounded dirty tracked inputs, on demand. */
async function capture(
  workspace: string,
  cwd: string,
  path: string,
  configuration: string,
  authorize: () => void,
): Promise<Capture> {
  const canonical = (value: string) => {
    authorize();
    return realpath(value);
  };
  const runGit = (directory: string, args: string[]) => {
    authorize();
    return git(directory, args);
  };
  const root = await canonical(workspace);
  const read = (value: string, optional = false, limit?: number) =>
    bytes(value, root, authorize, optional, limit);
  const working = await canonical(cwd);
  if (!contained(root, working)) throw new Error('READINESS_CWD_OUTSIDE_WORKSPACE');
  // Serena paths remain relative to its prepared project, even for a narrowed child cwd.
  const source = await canonical(resolve(root, path));
  if (!contained(working, source)) throw new Error('READINESS_SOURCE_OUTSIDE_CHILD');
  const repository = await canonical(
    (await runGit(dirname(source), ['rev-parse', '--show-toplevel'])).trim(),
  );
  if (!contained(root, repository) || !contained(repository, source))
    throw new Error('READINESS_REPOSITORY_OUTSIDE_WORKSPACE');
  const sourceBytes = await read(source);
  const head = (await runGit(repository, ['rev-parse', 'HEAD'])).trim();
  const dirty = (
    await runGit(repository, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-only',
      '-z',
      'HEAD',
    ])
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const untracked = (await runGit(repository, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean);
  const changed = [...new Set([...dirty, ...untracked])].sort();
  if (changed.length > 128) throw new Error('READINESS_DIRTY_SCOPE_TOO_LARGE');
  let inputBytes = 0;
  const dirtyInputs = [];
  for (const name of changed) {
    const content = await read(join(repository, name), true, 4_194_304 - inputBytes);
    inputBytes += content?.length ?? 0;
    if (inputBytes > 4_194_304) throw new Error('READINESS_DIRTY_SCOPE_TOO_LARGE');
    dirtyInputs.push([name, hash(content ?? 'deleted')]);
  }
  const metadata: Array<[string, string | null]> = [];
  const builds: string[] = [];
  for (const name of [
    ...new Set([
      join(repository, 'compile_commands.json'),
      join(repository, 'build/compile_commands.json'),
      join(working, 'compile_commands.json'),
    ]),
  ]) {
    const content = await read(name, true);
    metadata.push([name, content ? hash(content) : null]);
    if (!content) continue;
    const entries: unknown = JSON.parse(content.toString());
    if (!Array.isArray(entries) || entries.length > 20000)
      throw new Error('READINESS_BUILD_METADATA_INVALID');
    for (const entry of entries) {
      const item = record(entry);
      if (!small(item?.file) || !small(item?.directory) || !isAbsolute(item.directory)) continue;
      if (
        !small(item.command) &&
        !(Array.isArray(item.arguments) && item.arguments.length > 0 && item.arguments.every(small))
      )
        continue;
      const compiled = resolve(item.directory, item.file);
      if (basename(compiled) !== basename(source) || !contained(root, compiled)) continue;
      if ((await canonical(compiled)) !== source) continue;
      const build = await canonical(item.directory);
      if (!contained(repository, build)) throw new Error('READINESS_BUILD_OUTSIDE_REPOSITORY');
      // Keep every matching compile-command alias in the fingerprint; never rewrite selection.
      builds.push(hash(JSON.stringify([build, item])));
    }
  }
  for (const name of [
    '.serena/project.yml',
    '.xerjignore',
    'CMakePresets.json',
    'CMakeUserPresets.json',
  ]) {
    const content = await read(join(repository, name), true);
    metadata.push([name, content ? hash(content) : null]);
  }
  const id = hash(repository);
  return {
    source,
    root: repository,
    project: root,
    cwd: working,
    hasBuild: builds.length > 0,
    authorize,
    repository: {
      id,
      label: basename(repository)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, 96),
      buildIds: builds.sort(),
    },
    key: hash(
      JSON.stringify([
        id,
        working,
        head,
        hash(sourceBytes!),
        dirtyInputs,
        metadata,
        builds,
        configuration,
      ]),
    ),
  };
}

function payloads(result: unknown): unknown[] {
  const value = record(result);
  if (!value) return [];
  const output: unknown[] = value.structuredContent === undefined ? [] : [value.structuredContent];
  if (Array.isArray(value.content) && value.content.length <= 32) {
    for (const part of value.content) {
      const item = record(part);
      if (item?.type !== 'text' || typeof item.text !== 'string' || item.text.length > 65536)
        continue;
      try {
        output.push(JSON.parse(item.text));
      } catch {
        /* Unsupported output stays unknown. */
      }
    }
  }
  return output;
}

function symbolKind(kind: unknown): boolean {
  return (
    (typeof kind === 'number' && Number.isInteger(kind) && kind >= 1 && kind <= 26) ||
    (small(kind) &&
      /^(?:file|module|namespace|package|class|method|property|field|constructor|enum|interface|function|variable|constant|string|number|boolean|array|object|key|null|enummember|struct|event|operator|typeparameter)$/i.test(
        kind,
      ))
  );
}

function symbols(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1000) return [];
  return value.flatMap((item) => {
    const symbol = record(item);
    return symbol && (small(symbol.name_path) || small(symbol.name)) && symbolKind(symbol.kind)
      ? [symbol]
      : [];
  });
}

// Installed Serena 1.7 groups overviews by kind and references by path then kind.
// Counts, shortened prose and unknown shapes are deliberately not capability evidence.
function groupedSymbols(
  value: unknown,
  overview: boolean,
  path?: string,
): Record<string, unknown>[] {
  const groups = record(value);
  if (!groups || Object.keys(groups).length > 32) return [];
  const result = [];
  for (const [kind, members] of Object.entries(groups)) {
    if (!symbolKind(kind) || !Array.isArray(members) || members.length > 1000) continue;
    for (const member of members) {
      if (overview && small(member)) result.push({ name: member, kind });
      else {
        const symbol = record(member);
        if (symbol && (small(symbol.name_path) || small(symbol.name)))
          result.push({ ...symbol, kind, ...(path ? { relative_path: path } : {}) });
        else if (overview && symbol && Object.keys(symbol).length === 1) {
          const name = Object.keys(symbol)[0];
          const children = record(symbol[name]);
          if (small(name) && children && Object.keys(children).every(symbolKind))
            result.push({ name, kind });
        }
      }
      if (result.length >= 1000) return result;
    }
  }
  return result;
}

function decodedSymbols(tool: string, payload: unknown): Record<string, unknown>[] {
  const flat = symbols(payload);
  if (flat.length) return flat;
  if (tool === 'get_symbols_overview') return groupedSymbols(payload, true);
  if (tool !== 'find_referencing_symbols') return [];
  const paths = record(payload);
  if (!paths || Object.keys(paths).length > 128) return [];
  return Object.entries(paths)
    .flatMap(([path, groups]) => groupedSymbols(groups, false, path))
    .slice(0, 1000);
}

async function usable(tool: string, result: unknown, bound: Capture): Promise<boolean> {
  bound.authorize();
  for (const payload of payloads(result)) {
    const candidates = decodedSymbols(tool, payload);
    if (tool !== 'find_referencing_symbols') {
      for (const candidate of candidates) {
        if (!candidate.relative_path) return true;
        if (small(candidate.relative_path)) {
          bound.authorize();
          if ((await realpath(resolve(bound.project, candidate.relative_path))) === bound.source)
            return true;
        }
      }
    }
    if (tool === 'find_referencing_symbols' && candidates.length) {
      if (/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(bound.source) && !bound.hasBuild) return false;
      for (const candidate of candidates) {
        if (!small(candidate.relative_path)) continue;
        bound.authorize();
        const target = await realpath(resolve(bound.project, candidate.relative_path));
        if (contained(bound.root, target) && contained(bound.cwd, target)) return true;
      }
    }
  }
  return false;
}

/** One observer per prepared runtime. It never changes projects, permissions or index ownership. */
export class RepositoryReadiness {
  readonly runtimeId = randomUUID();
  private readonly settings = new Map<string, unknown>();
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<
    string,
    { capture: Promise<Pending | null>; ready: boolean }
  >();
  private epoch = 0;
  private projectChanged = false;

  constructor(private readonly workspace: string) {}

  /** Already observed state for activity publication; no filesystem or tool work. */
  peek(): Array<{ threadId: string; readiness: RetrievalReadiness }> {
    return [...this.entries.values()].map((entry) => ({
      threadId: entry.threadId,
      readiness: entry.evidence.snapshot(),
    }));
  }

  private async binding(
    rpc: Rpc,
    rootThreadId: string,
    threadId: string,
    path: string,
    current: () => boolean,
  ): Promise<Capture> {
    const deadline = Date.now() + 2500;
    const result = record(
      await beforeDeadline(rpc.request('thread/read', { threadId, includeTurns: false }), deadline),
    );
    const thread = record(result?.thread);
    if (
      thread?.id !== threadId ||
      !small(thread.cwd) ||
      (threadId !== rootThreadId && thread.parentThreadId !== rootThreadId) ||
      !['active', 'idle'].includes(String(record(thread.status)?.type))
    )
      throw new Error('READINESS_THREAD_UNVERIFIED');
    const config = await beforeDeadline(
      rpc.request('config/read', { includeLayers: false, cwd: thread.cwd }),
      deadline,
    );
    if (!record(record(config)?.config)) throw new Error('READINESS_CONFIG_UNVERIFIED');
    const settings = this.settings.get(threadId);
    const authorize = () => {
      if (
        !current() ||
        this.settings.get(threadId) !== settings ||
        !hasUnrestrictedReadAuthority(settings, record(config)?.config, String(thread.cwd))
      )
        throw new Error('READINESS_READ_AUTHORITY_UNKNOWN');
    };
    authorize();
    const status = record(
      await beforeDeadline(
        rpc.request('mcpServerStatus/list', {
          threadId,
          serverName: 'gestalt-serena',
          detail: 'full',
        }),
        deadline,
      ),
    );
    const server = Array.isArray(status?.data)
      ? status.data.map(record).find((item) => item?.name === 'gestalt-serena')
      : undefined;
    if (server?.runtimeStatus !== 'connected' || server.toolsError || !record(server.tools))
      throw new Error('READINESS_CONNECTION_UNVERIFIED');
    return capture(
      this.workspace,
      thread.cwd,
      path,
      hash(JSON.stringify([config, server.tools, settings])),
      authorize,
    );
  }

  async observe(
    rpc: Rpc,
    rootThreadId: string,
    notification: Notification,
    current: () => boolean,
  ): Promise<void> {
    const params = record(notification.params);
    const threadId = params?.threadId;
    if (
      notification.method === 'thread/settings/updated' &&
      small(threadId) &&
      (this.settings.has(threadId) || this.settings.size < 64)
    )
      this.settings.set(threadId, params?.threadSettings);
    if (
      (notification.method === 'mcpServer/statusUpdated' && params?.name === 'gestalt-serena') ||
      notification.method === 'thread/settings/updated' ||
      (notification.method === 'item/completed' && record(params?.item)?.type === 'fileChange')
    ) {
      this.epoch += 1;
      for (const entry of this.entries.values()) {
        if (
          !small(threadId) ||
          threadId === rootThreadId ||
          entry.threadId === threadId ||
          notification.method === 'item/completed'
        ) {
          entry.evidence.invalidate();
          if (
            notification.method === 'mcpServer/statusUpdated' &&
            ['failed', 'cancelled'].includes(String(params?.status))
          )
            entry.evidence.connection('unavailable');
        }
      }
      return;
    }
    const item = record(params?.item);
    if (
      item?.type === 'mcpToolCall' &&
      item.server === 'gestalt-serena' &&
      notification.method === 'item/started' &&
      ![
        'get_symbols_overview',
        'find_symbol',
        'find_referencing_symbols',
        'initial_instructions',
      ].includes(String(item.tool))
    ) {
      this.epoch += 1;
      if (['activate_project', 'switch_modes'].includes(String(item.tool)))
        this.projectChanged = true;
      for (const entry of this.entries.values()) entry.evidence.invalidate();
    }
    if (
      !current() ||
      this.projectChanged ||
      !small(threadId) ||
      item?.type !== 'mcpToolCall' ||
      item.server !== 'gestalt-serena' ||
      !small(item.id) ||
      !['get_symbols_overview', 'find_symbol', 'find_referencing_symbols'].includes(
        String(item.tool),
      )
    )
      return;
    const key = `${threadId}:${item.id}`;
    if (notification.method === 'item/started') {
      const path = record(item.arguments)?.relative_path;
      if (!small(path) || this.pending.size >= 128) return;
      const epoch = this.epoch;
      const slot: { capture: Promise<Pending | null>; ready: boolean } = {
        capture: Promise.resolve(null),
        ready: false,
      };
      slot.capture = this.binding(rpc, rootThreadId, threadId, path, current)
        .then((bound) => {
          if (!current() || epoch !== this.epoch) return null;
          const entryKey = `${threadId}:${bound.repository.id}`;
          let entry = this.entries.get(entryKey);
          if (!entry) {
            if (this.entries.size >= 64) return null;
            entry = { evidence: new ReadinessEvidence(), capture: bound, threadId };
            this.entries.set(entryKey, entry);
          }
          entry.capture = bound;
          const generation = entry.evidence.bind(bound.key, bound.repository);
          entry.evidence.connection('ready');
          slot.ready = true;
          return { capture: bound, entry, generation, tool: String(item.tool), path, epoch };
        })
        .catch(() => null);
      this.pending.set(key, slot);
      await slot.capture;
    } else if (notification.method === 'item/completed') {
      const pending = this.pending.get(key);
      this.pending.delete(key);
      if (!pending?.ready) return;
      const before = await pending.capture;
      if (!before || !current()) return;
      try {
        const after = await this.binding(rpc, rootThreadId, threadId, before.path, current);
        if (!current() || before.epoch !== this.epoch || before.capture.key !== after.key) {
          before.entry.evidence.invalidate();
          return;
        }
        const failed =
          item.status === 'failed' || item.error != null || record(item.result)?.isError === true;
        if (failed)
          before.entry.evidence.semantic(
            before.generation,
            before.tool,
            false,
            hash(before.capture.source),
          );
        else if (
          item.status === 'completed' &&
          (await usable(before.tool, item.result, after)) &&
          current() &&
          before.epoch === this.epoch
        )
          before.entry.evidence.semantic(
            before.generation,
            before.tool,
            true,
            hash(before.capture.source),
          );
      } catch {
        before.entry.evidence.invalidate();
      }
    }
  }

  async snapshot(
    rpc: Rpc,
    rootThreadId: string,
    current: () => boolean,
  ): Promise<Array<{ threadId: string; readiness: RetrievalReadiness }>> {
    const output = [];
    const deadline = Date.now() + 5000;
    for (const entry of this.entries.values()) {
      try {
        if (Date.now() >= deadline) throw new Error('READINESS_REFRESH_TIMEOUT');
        const fresh = await beforeDeadline(
          this.binding(
            rpc,
            rootThreadId,
            entry.threadId,
            entry.capture.source,
            () => current() && Date.now() < deadline,
          ),
          deadline,
        );
        if (fresh.key !== entry.capture.key) entry.evidence.invalidate();
      } catch {
        entry.evidence.invalidate();
      }
      if (!current()) return [];
      output.push({ threadId: entry.threadId, readiness: entry.evidence.snapshot() });
    }
    return output;
  }
}
