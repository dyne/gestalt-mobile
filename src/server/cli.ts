/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { composeRelayApp } from './composition.js';
import { CliUsageError, parseConfig, type RelayConfig } from './config.js';
import { CodexProfileCatalog } from './platform/catalog/codex-profile-catalog.js';
import { FilesystemSkillProfileStore } from './platform/skills/filesystem-skill-profile-store.js';

const runFile = promisify(execFile);

export const usage = `Usage: gestalt-mobile [options]

Options:
  --cwd <path>       Workspace root (default: current directory)
  --host <address>   Listen address (default: 127.0.0.1)
  --port <number>    Listen port (default: 3000)
  --data-dir <path>  Directory for persistent application data
  --skills <profile> Use a global skill profile for every session
  --skills list      List saved global skill profiles without starting the server
  --help             Show this help
  --version          Show the installed version`;

type Output = Pick<NodeJS.WriteStream, 'write'>;

export type CliDependencies = {
  args?: string[];
  cwd?: string;
  moduleUrl?: string;
  stdout?: Output;
  stderr?: Output;
  signalSource?: Pick<NodeJS.Process, 'once' | 'removeListener'>;
  probeCodexVersion?: () => Promise<string | null>;
  compose?: typeof composeRelayApp;
  homeDirectory?: string;
};

export function packageRoot(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    if (existsSync(resolve(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Gestalt Mobile package root is unavailable');
    directory = parent;
  }
}

export function packagedClientDir(moduleUrl: string): string | undefined {
  const directory = resolve(packageRoot(moduleUrl), 'dist/client');
  return existsSync(resolve(directory, 'index.html')) ? directory : undefined;
}

export async function packageVersion(moduleUrl: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(resolve(packageRoot(moduleUrl), 'package.json'), 'utf8'),
  ) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error('Package version is unavailable');
  return manifest.version;
}

export async function probeCodexVersion(): Promise<string | null> {
  return runFile('codex', ['--version'])
    .then(({ stdout }) => stdout.trim() || null)
    .catch(() => null);
}

export function installShutdownHandlers(
  app: { close: () => Promise<unknown> },
  signalSource: Pick<NodeJS.Process, 'once' | 'removeListener'> = process,
): () => Promise<unknown> {
  let closing: Promise<unknown> | undefined;
  const shutdown = () => {
    closing ??= app.close();
    return closing;
  };
  const onSignal = () => {
    signalSource.removeListener('SIGINT', onSignal);
    signalSource.removeListener('SIGTERM', onSignal);
    void shutdown().catch((error: unknown) => {
      process.exitCode = 1;
      console.error(error instanceof Error ? error.message : 'Shutdown failed');
    });
  };
  signalSource.once('SIGINT', onSignal);
  signalSource.once('SIGTERM', onSignal);
  return shutdown;
}

function parseInvocation(
  args: string[],
  cwd: string,
): { command: 'run'; config: RelayConfig } | { command: 'help' } | { command: 'version' } | { command: 'list' } {
  if (args.includes('--help')) {
    if (args.length !== 1)
      throw new CliUsageError('--help cannot be combined with other arguments');
    return { command: 'help' };
  }
  if (args.includes('--version')) {
    if (args.length !== 1)
      throw new CliUsageError('--version cannot be combined with other arguments');
    return { command: 'version' };
  }
  const skills = args.indexOf('--skills');
  if (skills !== -1 && args[skills + 1] === 'list') {
    if (args.length !== 2) throw new CliUsageError('--skills list cannot be combined with other arguments');
    return { command: 'list' };
  }
  return { command: 'run', config: parseConfig(args, cwd) };
}

async function listSkillProfiles(store: FilesystemSkillProfileStore, stdout: Output, stderr: Output): Promise<number> {
  let failed = false;
  for (const name of await store.listGlobalProfileNames()) {
    try {
      const profile = await store.readGlobalProfile(name);
      if (!profile) continue;
      stdout.write(`${profile.name}\n  ${store.globalProfilePath(name)}\n`);
      for (const skill of [...profile.skills].filter((entry) => entry.enabled).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)))
        stdout.write(`  ${skill.name}\t${skill.path}\n`);
    } catch (error) {
      failed = true;
      stderr.write(`${name}: ${error instanceof Error ? error.message : 'Invalid skill profile.'}\n`);
    }
  }
  return failed ? 1 : 0;
}

export async function runCli(dependencies: CliDependencies = {}): Promise<number> {
  const args = dependencies.args ?? process.argv.slice(2);
  const cwd = dependencies.cwd ?? process.cwd();
  const moduleUrl = dependencies.moduleUrl ?? import.meta.url;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  let invocation: ReturnType<typeof parseInvocation>;

  try {
    invocation = parseInvocation(args, cwd);
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error;
    stderr.write(`${error.message}\n\n${usage}\n`);
    return error.exitCode;
  }

  if (invocation.command === 'help') {
    stdout.write(`${usage}\n`);
    return 0;
  }
  if (invocation.command === 'version') {
    stdout.write(`${await packageVersion(moduleUrl)}\n`);
    return 0;
  }
  const skillProfiles = new FilesystemSkillProfileStore(dependencies.homeDirectory ?? homedir());
  if (invocation.command === 'list') return listSkillProfiles(skillProfiles, stdout, stderr);

  const config = invocation.config;
  let explicitSkillProfile;
  try {
    explicitSkillProfile = config.skillsProfile
      ? await skillProfiles.readGlobalProfile(config.skillsProfile)
      : undefined;
  } catch {
    stderr.write(`Invalid skill profile: ${config.skillsProfile}\n\n${usage}\n`);
    return 2;
  }
  if (config.skillsProfile && !explicitSkillProfile) {
    stderr.write(`Unknown skill profile: ${config.skillsProfile}\n\n${usage}\n`);
    return 2;
  }
  const app = await (dependencies.compose ?? composeRelayApp)({
    root: config.root,
    dataDir: config.dataDir,
    staticDir: packagedClientDir(moduleUrl),
    profiles: new CodexProfileCatalog(),
    installedCodexVersion: await (dependencies.probeCodexVersion ?? probeCodexVersion)(),
    startAppServers: true,
    homeDirectory: dependencies.homeDirectory,
    explicitSkillProfile,
    planMeasurementBaseUrl: `http://${config.host}:${config.port}`,
  });
  installShutdownHandlers(app, dependencies.signalSource);
  let address: string;
  try {
    address = await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  stdout.write(`Gestalt Mobile listening on ${address}\n`);
  return 0;
}
