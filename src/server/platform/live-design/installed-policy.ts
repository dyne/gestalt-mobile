/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { readLiveConfigFile, type LiveConfigFile } from './effective-config.js';
import { LIVE_CODEX_SHA256 } from './native-contract.js';
export { LIVE_CODEX_SHA256 } from './native-contract.js';

const runFile = promisify(execFile);
// Fixed refusal vocabulary from the pinned Manager v2 and Agents contracts.
// Never retain command stdout/stderr or copy an arbitrary reason into evidence.
const admissionReasons = new Set(
  `active-launch active-runtime-admission admission-unavailable binary-changed command-changed config-changed configuration-changed host-launch-unavailable incompatible-binary incompatible-manager incompatible-manifest incompatible-native-policy incompatible-profile incomplete-source-inventory interpreter-changed interpreter-unavailable invalid-admission-command invalid-admission-input invalid-arguments invalid-capture-id invalid-commands invalid-config invalid-contract invalid-controller invalid-generation invalid-key invalid-launch-id invalid-lifecycle-scope invalid-manifest invalid-owning-runtime invalid-path invalid-process invalid-receipt invalid-runtime-provenance invalid-signing-key invalid-source-inventory manager-changed metadata-before-runtime-birth metadata-changed metadata-content-present metadata-provenance-unavailable missing-components missing-config missing-election missing-owning-config missing-prerequisite missing-private-paths missing-profile missing-runtime-provenance native-policy-unavailable native-worker-active oversized-admission-input oversized-package package-changed package-identity-mismatch package-launch-changed package-symlink prepared-config-changed private-app-overlap project-config-present project-config-unavailable project-writable-admission project-writable-policy reused-capture-id reused-launch-id revoked-runtime-provenance runtime-changed source-changed stale-admission-receipt stale-controller stale-election stale-policy-receipt stale-process stale-receipt stale-runtime-provenance symlink-path tampered-receipt unadmitted-command unadmitted-launch-surface unadmitted-native-command unauthorized-controller unbound-bootstrap unbound-prepared-config unknown-plugin unowned-runtime-admission unsafe-environment unsafe-live-proxy-environment unsafe-runtime-config unsafe-runtime-home unsupported-admission-version unsupported-host unsupported-host-clock unsupported-host-namespace unsupported-lifecycle-consumer unsupported-system-config untrusted-ancestor untrusted-binary untrusted-bootstrap-storage untrusted-interpreter-directory untrusted-manager untrusted-mode untrusted-owner untrusted-package-directory untrusted-package-file untrusted-path untrusted-stdio-bridge untrusted-storage unverified-owning-runtime workspace-mismatch`.split(
    ' ',
  ),
);
export class InstalledLiveAdmissionError extends Error {
  constructor(readonly diagnostic: { phase: string; reason: string }) {
    super('LIVE_ADMISSION_UNAVAILABLE');
  }
  static command(phase: 'manager-command' | 'agents-command', failure: unknown) {
    let reason = 'command-failed';
    try {
      const stdout = (failure as { stdout?: unknown })?.stdout;
      if (typeof stdout === 'string' && stdout.length <= 16384) {
        const reply = JSON.parse(stdout);
        if (
          [1, 2].includes(reply.schemaVersion) &&
          reply.available === false &&
          reply.liveReady === false
        )
          reason = admissionReasons.has(reply.reason) ? reply.reason : 'contract-refused';
      }
    } catch {
      /* Malformed or non-protocol output never enters diagnostics. */
    }
    return new InstalledLiveAdmissionError({ phase, reason });
  }
}
export const LIVE_MANAGER_SHA256 =
  'ea653b0802fbafae8baac7c194e15baf03d770abb74848bb892e81e739743d82';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const pin = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const packagePin = z
  .object({
    name: z.enum(['context-mode', 'gestalt']),
    root: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const installationSchema = z
  .object({
    manager: pin,
    node: pin,
    packages: z.array(packagePin).length(2),
    runtime: z.object({ root: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  })
  .strict();
export type TrustedLiveInstallation = z.infer<typeof installationSchema>;
const replySchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    available: z.literal(true),
    liveReady: z.literal(false),
  })
  .passthrough();

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}
function canonical(path: string, directory = false): string {
  const info = lstatSync(path);
  if (
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.mode & 0o022 ||
    (info.uid !== 0 && info.uid !== process.getuid?.())
  )
    throw new Error('LIVE_INSTALLATION_UNVERIFIED');
  return path;
}

/** Same installed-byte inventory as L10; verify BEFORE executing any installed host code. */
export function measureInstalledLiveTree(root: string): string {
  canonical(root, true);
  const files: [string, number, string][] = [];
  let bytes = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        info = lstatSync(path);
      if (info.isSymbolicLink() || info.mode & 0o022)
        throw new Error('LIVE_INSTALLATION_UNVERIFIED');
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      bytes += info.size;
      if (!info.isFile() || files.length >= 20000 || bytes > 512 * 1024 * 1024)
        throw new Error('LIVE_INSTALLATION_UNVERIFIED');
      files.push([relative(root, path), info.mode & 0o777, hash(readFileSync(path))]);
    }
  };
  walk(root);
  return hash(stable(files));
}

/** Private controller API. A policy/admission receipt is never a process adoption or readiness grant. */
export class InstalledLivePolicy {
  private readonly installation: TrustedLiveInstallation;
  constructor(installation: TrustedLiveInstallation) {
    this.installation = installationSchema.parse(structuredClone(installation));
    if (
      installation.manager.sha256 !== LIVE_MANAGER_SHA256 ||
      new Set(installation.packages.map((item) => item.name)).size !== 2
    )
      throw new Error('LIVE_INSTALLATION_UNVERIFIED');
  }
  private verifyHostExecutables(): void {
    const { manager, node } = this.installation;
    for (const binary of [manager, node]) {
      canonical(binary.path);
      if (
        !(lstatSync(binary.path).mode & 0o111) ||
        hash(readFileSync(binary.path)) !== binary.sha256
      )
        throw new Error('LIVE_INSTALLATION_UNVERIFIED');
    }
    if (
      basename(node.path) !== 'node' ||
      (dirname(node.path) !== '/usr/bin' &&
        stable(readdirSync(dirname(node.path)).sort()) !== stable(['node']))
    )
      throw new Error('LIVE_INSTALLATION_UNVERIFIED');
  }
  private verifyInstallation(): void {
    this.verifyHostExecutables();
    const { packages, runtime } = this.installation;
    for (const entry of [...packages, runtime])
      if (measureInstalledLiveTree(entry.root) !== entry.sha256)
        throw new Error('LIVE_INSTALLATION_UNVERIFIED');
  }
  /** Installed-byte validation only; never a readiness/process admission claim. */
  validateInstallation(): void {
    this.verifyInstallation();
  }
  /** Manager signs only for its direct elected-controller parent. These typed
   * operations never accept a command, environment, or project-provided argv. */
  private async runtimeCommand(
    manifestPath: string,
    action: 'capture-runtime' | 'seal-runtime' | 'revoke-runtime',
    captureId: string,
    tail: readonly string[] = [],
  ): Promise<Record<string, unknown>> {
    if (action === 'revoke-runtime') this.verifyHostExecutables();
    else this.verifyInstallation();
    canonical(manifestPath);
    z.uuid({ version: 'v4' }).parse(captureId);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.schemaVersion !== 2)
      throw Object.assign(new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE'), {
        code: 'LIVE_RUNTIME_MANIFEST_INVALID',
      });
    const result = await this.command(
      this.installation.manager.path,
      ['live-policy', action, '--manifest', manifestPath, '--capture-id', captureId, ...tail],
      dirname(manifestPath),
      z.string().parse(manifest.runtimeHome),
      action !== 'revoke-runtime',
    );
    if (result.schemaVersion !== 2 || result.captureId !== captureId)
      throw Object.assign(new Error('LIVE_RUNTIME_PROVENANCE_UNAVAILABLE'), {
        code: 'LIVE_RUNTIME_RECEIPT_INVALID',
      });
    return result;
  }
  captureRuntime(manifestPath: string, captureId: string): Promise<Record<string, unknown>> {
    return this.runtimeCommand(manifestPath, 'capture-runtime', captureId);
  }
  sealRuntime(
    manifestPath: string,
    captureId: string,
    runtimePid: number,
    sourcesPath: string,
  ): Promise<Record<string, unknown>> {
    z.number().int().positive().safe().parse(runtimePid);
    canonical(sourcesPath);
    return this.runtimeCommand(manifestPath, 'seal-runtime', captureId, [
      '--runtime-pid',
      String(runtimePid),
      '--sources',
      sourcesPath,
    ]);
  }
  async revokeRuntime(manifestPath: string, captureId: string): Promise<void> {
    await this.runtimeCommand(manifestPath, 'revoke-runtime', captureId);
  }
  async bootstrapRuntime(manifestPath: string): Promise<void> {
    this.verifyInstallation();
    canonical(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    try {
      await runFile(
        this.installation.manager.path,
        ['cli', '--', '--live-policy-bootstrap', '--manifest', manifestPath],
        {
          cwd: dirname(manifestPath),
          env: {
            PATH: [...new Set([dirname(this.installation.node.path), '/usr/bin', '/bin'])].join(
              ':',
            ),
            HOME: z.string().parse(manifest.runtimeHome),
            LANG: 'C.UTF-8',
          },
          timeout: 30000,
          maxBuffer: 16384,
        },
      );
      this.verifyInstallation();
    } catch {
      throw new Error('LIVE_RUNTIME_BOOTSTRAP_UNAVAILABLE');
    }
  }
  private async command(
    binary: string,
    args: string[],
    cwd: string,
    home: string,
    verifyComplete = true,
  ): Promise<Record<string, unknown>> {
    try {
      const { stdout } = await runFile(binary, args, {
        cwd,
        env: {
          PATH: [...new Set([dirname(this.installation.node.path), '/usr/bin', '/bin'])].join(':'),
          HOME: home,
          LANG: 'C.UTF-8',
        },
        timeout: 30000,
        maxBuffer: 16384,
      });
      const result = replySchema.parse(JSON.parse(stdout));
      if (verifyComplete) this.verifyInstallation();
      else this.verifyHostExecutables();
      return result;
    } catch (error) {
      // execFile errors contain argv, output and potentially configuration secrets.
      throw InstalledLiveAdmissionError.command(
        binary === this.installation.manager.path ? 'manager-command' : 'agents-command',
        error,
      );
    }
  }
  private inputs(
    manifestPath: string,
    bootstrapPath: string,
    files: readonly LiveConfigFile[],
  ): {
    directory: string;
    home: string;
  } {
    this.verifyInstallation();
    canonical(manifestPath);
    canonical(bootstrapPath);
    for (const path of [manifestPath, bootstrapPath]) {
      if ((lstatSync(path).mode & 0o777) !== 0o600) throw new Error('LIVE_ADMISSION_UNAVAILABLE');
      readLiveConfigFile(path);
    }
    const directory = canonical(dirname(manifestPath), true);
    if (dirname(bootstrapPath) !== directory || (lstatSync(directory).mode & 0o777) !== 0o700)
      throw new Error('LIVE_ADMISSION_UNAVAILABLE');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8')) as Record<string, unknown>;
    if (
      bootstrap.manifestPath !== manifestPath ||
      stable(bootstrap.packages) !== stable(this.installation.packages) ||
      stable(bootstrap.node) !== stable(this.installation.node) ||
      stable(bootstrap.runtime) !== stable(this.installation.runtime)
    )
      throw new Error('LIVE_INSTALLATION_UNVERIFIED');
    const binary = z
      .object({
        path: z.string(),
        version: z.literal('0.161.0'),
        sha256: z.literal(LIVE_CODEX_SHA256),
      })
      .strict()
      .parse(manifest.binary);
    canonical(binary.path);
    if (hash(readFileSync(binary.path)) !== LIVE_CODEX_SHA256)
      throw new Error('LIVE_INSTALLATION_UNVERIFIED');
    const configs = z.array(pin).min(1).parse(manifest.configFiles);
    if (
      !files.length ||
      files.some(
        (file) =>
          !configs.some((entry) => entry.path === file.path && entry.sha256 === file.sha256),
      )
    )
      throw new Error('LIVE_EFFECTIVE_CONFIG_UNAVAILABLE');
    for (const file of files)
      if (readLiveConfigFile(file.path).sha256 !== file.sha256)
        throw new Error('LIVE_CONFIG_CHANGED');
    const home = z.string().parse(manifest.runtimeHome);
    canonical(home, true);
    return { directory, home };
  }
  /** The actual source inventory must already be in the controller manifest.
   * Stage adds only L10's generated config; it never replaces resolved owning config.
   * Failed staging/preparation remains unavailable and preserves recovery evidence.
   */
  async stage(
    manifestPath: string,
    bootstrapPath: string,
    files: readonly LiveConfigFile[],
  ): Promise<string> {
    const input = this.inputs(manifestPath, bootstrapPath, files);
    const before = readLiveConfigFile(manifestPath).sha256;
    const bootstrap = readLiveConfigFile(bootstrapPath).sha256;
    const gestalt = this.installation.packages.find((entry) => entry.name === 'gestalt')!;
    const staged = await this.command(
      this.installation.node.path,
      [join(gestalt.root, 'scripts/live-admission.mjs'), 'stage', '--bootstrap', bootstrapPath],
      input.directory,
      input.home,
    );
    const configPath = join(input.directory, 'live-mcp-config.json');
    if (
      staged.configPath !== configPath ||
      staged.sha256 !== readLiveConfigFile(configPath).sha256 ||
      readLiveConfigFile(manifestPath).sha256 !== before ||
      readLiveConfigFile(bootstrapPath).sha256 !== bootstrap
    )
      throw new Error('LIVE_CONFIG_CHANGED');
    return configPath;
  }
  async prepare(
    manifestPath: string,
    bootstrapPath: string,
    files: readonly LiveConfigFile[],
  ): Promise<{
    policyDigest: string;
    configDigest: string;
    admissionDigest: string;
  }> {
    try {
      const input = this.inputs(manifestPath, bootstrapPath, files);
      const before = readLiveConfigFile(manifestPath).sha256;
      const bootstrap = readLiveConfigFile(bootstrapPath).sha256;
      await this.command(
        this.installation.manager.path,
        ['live-policy', 'probe', '--manifest', manifestPath],
        input.directory,
        input.home,
      );
      const gestalt = this.installation.packages.find((entry) => entry.name === 'gestalt')!;
      const staged = await this.command(
        this.installation.node.path,
        [join(gestalt.root, 'scripts/live-admission.mjs'), 'stage', '--bootstrap', bootstrapPath],
        input.directory,
        input.home,
      );
      const configPath = join(input.directory, 'live-mcp-config.json');
      if (
        staged.configPath !== configPath ||
        staged.sha256 !== readLiveConfigFile(configPath).sha256 ||
        readLiveConfigFile(manifestPath).sha256 !== before ||
        readLiveConfigFile(bootstrapPath).sha256 !== bootstrap
      )
        throw new Error('LIVE_CONFIG_CHANGED');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const configs = z.array(pin).parse(manifest.configFiles);
      manifest.configFiles = [
        ...configs.filter((entry) => entry.path !== bootstrapPath && entry.path !== configPath),
        readLiveConfigFile(bootstrapPath),
        readLiveConfigFile(configPath),
      ];
      const temporary = `${manifestPath}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, `${stable(manifest)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, manifestPath);
      } finally {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      this.inputs(manifestPath, bootstrapPath, files);
      await this.command(
        this.installation.manager.path,
        ['live-policy', 'prepare', '--manifest', manifestPath],
        input.directory,
        input.home,
      );
      await this.command(
        this.installation.node.path,
        [join(gestalt.root, 'scripts/live-admission.mjs'), 'prepare', '--bootstrap', bootstrapPath],
        input.directory,
        input.home,
      );
      return await this.verify(manifestPath, bootstrapPath, files);
    } catch {
      throw new Error('LIVE_ADMISSION_UNAVAILABLE');
    }
  }
  async verify(
    manifestPath: string,
    bootstrapPath: string,
    files: readonly LiveConfigFile[],
  ): Promise<{
    policyDigest: string;
    configDigest: string;
    admissionDigest: string;
  }> {
    let phase = 'inputs-before';
    try {
      const before = this.inputs(manifestPath, bootstrapPath, files);
      const manifestDigest = readLiveConfigFile(manifestPath).sha256;
      const bootstrapDigest = readLiveConfigFile(bootstrapPath).sha256;
      phase = 'manager-verification';
      const manager = await this.command(
        this.installation.manager.path,
        ['live-policy', 'verify', '--manifest', manifestPath],
        before.directory,
        before.home,
      );
      const gestalt = this.installation.packages.find((entry) => entry.name === 'gestalt')!;
      phase = 'agents-verification';
      const agents = await this.command(
        this.installation.node.path,
        [join(gestalt.root, 'scripts/live-admission.mjs'), 'verify', '--bootstrap', bootstrapPath],
        before.directory,
        before.home,
      );
      phase = 'inputs-after';
      this.inputs(manifestPath, bootstrapPath, files);
      if (
        readLiveConfigFile(manifestPath).sha256 !== manifestDigest ||
        readLiveConfigFile(bootstrapPath).sha256 !== bootstrapDigest
      )
        throw new Error('LIVE_CONFIG_CHANGED');
      phase = 'result-digests';
      const digest = z.string().regex(/^[a-f0-9]{64}$/);
      return {
        policyDigest: digest.parse(manager.policyDigest),
        configDigest: digest.parse(manager.configDigest),
        admissionDigest: digest.parse(agents.admissionDigest),
      };
    } catch (error) {
      if (error instanceof InstalledLiveAdmissionError) throw error;
      throw new InstalledLiveAdmissionError({
        phase,
        reason:
          error instanceof Error &&
          [
            'LIVE_INSTALLATION_UNVERIFIED',
            'LIVE_CONFIG_CHANGED',
            'LIVE_EFFECTIVE_CONFIG_UNAVAILABLE',
          ].includes(error.message)
            ? error.message
            : 'verification-failed',
      });
    }
  }
}
