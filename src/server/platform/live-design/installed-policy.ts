/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
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
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readLiveConfigFile, type LiveConfigFile } from './effective-config.js';
import { LIVE_CODEX_SHA256 } from './native-contract.js';
import {
  LIVE_MANAGER_OBSERVATION_MS,
  ORIGINAL_INSTALLED_SOURCE_EXTENSION,
  originalInstalledSourceSchema,
  type InstalledSourceObservation,
} from './installed-launch-contract.js';
export { LIVE_CODEX_SHA256 } from './native-contract.js';

const runFile = promisify(execFile);
// Fixed controller operation: only the pinned observer module is imported.
// Source walks run outside Mobile's event loop and have their own phase budget.
const observeInstalledSources = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { observeOriginalLaunchSources } = await import(pathToFileURL(process.argv[2]).href);
const observed = observeOriginalLaunchSources(JSON.parse(readFileSync(process.argv[1], 'utf8')), JSON.parse(process.argv[3]));
process.stdout.write(JSON.stringify(observed));
`;
// Fixed refusal vocabulary from the pinned Manager v2 and Agents contracts.
// Never retain command stdout/stderr or copy an arbitrary reason into evidence.
const admissionReasons = new Set(
  `invalid-renewal-lineage renewal-intent-changed renewal-not-revoked renewal-observation-required renewal-owner-alive renewal-policy-broadened renewal-policy-incompatible renewal-required renewal-source-changed renewal-storage-reused renewal-undrained active-launch active-runtime-admission admission-unavailable binary-changed command-changed config-changed configuration-changed host-launch-unavailable incompatible-binary incompatible-manager incompatible-manifest incompatible-native-policy incompatible-profile incomplete-source-inventory interpreter-changed interpreter-unavailable invalid-admission-command invalid-admission-input invalid-arguments invalid-capture-id invalid-commands invalid-config invalid-contract invalid-controller invalid-generation invalid-key invalid-launch-id invalid-lifecycle-scope invalid-manifest invalid-owning-runtime invalid-path invalid-process invalid-receipt invalid-runtime-provenance invalid-signing-key invalid-source-inventory manager-changed metadata-before-runtime-birth metadata-changed metadata-content-present metadata-provenance-unavailable missing-components missing-config missing-election missing-owning-config missing-prerequisite missing-private-paths missing-profile missing-runtime-provenance native-policy-unavailable native-worker-active oversized-admission-input oversized-package package-changed package-identity-mismatch package-launch-changed package-symlink prepared-config-changed private-app-overlap project-config-present project-config-unavailable project-writable-admission project-writable-policy reused-capture-id reused-launch-id revoked-runtime-provenance runtime-changed source-changed stale-admission-receipt stale-controller stale-election stale-policy-receipt stale-process stale-receipt stale-runtime-provenance symlink-path tampered-receipt unadmitted-command unadmitted-launch-surface unadmitted-native-command unauthorized-controller unbound-bootstrap unbound-prepared-config unknown-plugin unowned-runtime-admission unsafe-environment unsafe-live-proxy-environment unsafe-runtime-config unsafe-runtime-home unsupported-admission-version unsupported-host unsupported-host-clock unsupported-host-namespace unsupported-lifecycle-consumer unsupported-system-config untrusted-ancestor untrusted-binary untrusted-bootstrap-storage untrusted-interpreter-directory untrusted-manager untrusted-mode untrusted-owner untrusted-package-directory untrusted-package-file untrusted-path untrusted-stdio-bridge untrusted-storage unverified-owning-runtime workspace-mismatch`.split(
    ' ',
  ),
);
type AdmissionPrerequisites = {
  privatePaths: Record<'auth' | 'controller' | 'caddy' | 'daemon', boolean[]>;
  configFiles: boolean[];
  signingKey: boolean;
  runtimeHome: boolean;
  electionLock: boolean;
  electionDescriptor: boolean;
  receipts: boolean[];
  originalProcess: boolean[];
  sourcePins: Record<string, boolean[]>;
  sandboxPaths: Record<string, { role: string; present: boolean }[]>;
  commandExecutables: boolean[];
  stdioBridges: boolean[];
};
function admissionPrerequisites(manifestPath: string): AdmissionPrerequisites | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const root = dirname(manifestPath);
    const id = manifest.runtimeProvenance.captureId;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) return undefined;
    const sealedPath = join(root, `runtime-${id}.json`);
    const sealed = existsSync(sealedPath)
      ? JSON.parse(readFileSync(sealedPath, 'utf8')).body
      : undefined;
    const pid = sealed?.runtime?.process?.pid;
    const inventory = JSON.parse(readFileSync(join(root, 'owning-sources.json'), 'utf8'));
    return {
      privatePaths: Object.fromEntries(
        ['auth', 'controller', 'caddy', 'daemon'].map((role) => [
          role,
          manifest.privatePaths[role].map((path: string) => existsSync(path)),
        ]),
      ) as AdmissionPrerequisites['privatePaths'],
      configFiles: manifest.configFiles.map((file: { path: string }) => existsSync(file.path)),
      signingKey: existsSync(manifest.keyFile),
      runtimeHome: existsSync(manifest.runtimeHome),
      electionLock: existsSync(manifest.election.lockFile),
      electionDescriptor: existsSync(`/proc/${manifest.election.holder.pid}/fd/3`),
      receipts: [
        join(root, 'policy-receipt.json'),
        join(root, `birth-${id}.json`),
        sealedPath,
        join(root, `image-${id}.json`),
        join(
          dirname(manifest.election.lockFile),
          `runtime-admission-${hash(manifest.appRoot)}.json`,
        ),
      ].map((path) => existsSync(path)),
      originalProcess: ['exe', 'environ', 'cmdline', 'ns/mnt', 'ns/user', 'ns/pid'].map(
        (field) => Number.isSafeInteger(pid) && existsSync(`/proc/${pid}/${field}`),
      ),
      sourcePins: Object.fromEntries(
        ['file', 'directory', 'instruction', 'instruction-candidate'].map((kind) => [
          kind,
          inventory.sources
            .filter((source: { kind: string }) => source.kind === kind)
            .map((source: { path: string }) => existsSync(source.path)),
        ]),
      ),
      sandboxPaths: Object.fromEntries(
        ['read', 'write'].map((access) => [
          access,
          manifest.sandboxState.permissionProfile.file_system.entries
            .filter(
              (entry: { access: string; path: { type: string } }) =>
                entry.access === access && entry.path.type === 'path',
            )
            .map((entry: { path: { path: string } }) => {
              const path = entry.path.path;
              return {
                role:
                  path === manifest.appRoot
                    ? 'app'
                    : path === '/tmp'
                      ? 'tmp'
                      : (['previews', 'artifacts', 'annotations'].find(
                          (name) => path === join(manifest.appRoot, '.impeccable/live', name),
                        ) ?? 'other'),
                present: existsSync(path),
              };
            }),
        ]),
      ),
      commandExecutables: Object.values(manifest.commands).map((command) =>
        existsSync((command as { executable: string }).executable),
      ),
      stdioBridges: ['/usr/bin/bash', '/usr/bin/cat', '/usr/bin/env'].map((path) =>
        existsSync(path),
      ),
    };
  } catch {
    return undefined;
  }
}
export class InstalledLiveAdmissionError extends Error {
  constructor(
    readonly diagnostic: {
      phase: string;
      reason: string;
      prerequisites?: AdmissionPrerequisites;
    },
  ) {
    super('LIVE_ADMISSION_UNAVAILABLE');
  }
  static command(
    phase: 'manager-command' | 'agents-command',
    failure: unknown,
    prerequisites?: AdmissionPrerequisites,
  ) {
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
    return new InstalledLiveAdmissionError({ phase, reason, prerequisites });
  }
}
export const LIVE_MANAGER_SHA256 =
  '8115c37344ef4a7a1b537e23ff069a90bbb188ec41c77ace8d5a41cc864118f9';
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
  /** The pinned Agents observer independently reads executable/package/runtime
   * identity. Nothing from the original launcher is imported or executed. */
  async observeOriginalSources(
    manifestPath: string,
  ): Promise<readonly InstalledSourceObservation[]> {
    this.verifyInstallation();
    const before = readLiveConfigFile(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!Object.hasOwn(manifest, 'originalLaunchSources')) return [];
    const descriptor = z
      .tuple([originalInstalledSourceSchema])
      .parse(manifest.originalLaunchSources);
    if (descriptor[0].interpreter.path !== realpathSync(process.execPath))
      throw new Error('LIVE_INSTALLED_SOURCE_UNVERIFIED');
    const gestalt = this.installation.packages.find((p) => p.name === 'gestalt')!;
    let stdout: string;
    try {
      ({ stdout } = await runFile(
        this.installation.node.path,
        [
          '--input-type=module',
          '--eval',
          observeInstalledSources,
          manifestPath,
          join(gestalt.root, 'live-installed-source.mjs'),
          JSON.stringify(this.installation),
        ],
        {
          cwd: dirname(manifestPath),
          env: {
            PATH: [...new Set([dirname(this.installation.node.path), '/usr/bin', '/bin'])].join(
              ':',
            ),
            HOME: z.string().parse(manifest.runtimeHome),
            LANG: 'C.UTF-8',
          },
          timeout: LIVE_MANAGER_OBSERVATION_MS + 5_000,
          maxBuffer: 262144,
        },
      ));
    } catch {
      throw new Error('LIVE_INSTALLED_SOURCE_UNVERIFIED');
    }
    const observations = z
      .array(
        z
          .object({
            kind: z.literal('installed-launch-source'),
            descriptor: originalInstalledSourceSchema,
            observation: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .length(1)
      .parse(JSON.parse(stdout));
    this.verifyInstallation();
    if (
      !isDeepStrictEqual(
        observations.map((p) => p.descriptor),
        descriptor,
      ) ||
      !isDeepStrictEqual(readLiveConfigFile(manifestPath), before)
    )
      throw new Error('LIVE_INSTALLED_SOURCE_UNVERIFIED');
    return structuredClone(observations);
  }
  assertOriginalSourceReply(
    reply: Record<string, unknown>,
    observations: readonly InstalledSourceObservation[],
  ): void {
    if (
      observations.length &&
      (!Array.isArray(reply.extensions) ||
        !reply.extensions.includes(ORIGINAL_INSTALLED_SOURCE_EXTENSION) ||
        !isDeepStrictEqual(reply.originalLaunchSources, observations))
    )
      throw new Error('LIVE_INSTALLED_SOURCE_UNVERIFIED');
  }
  /** Renewal stdout intentionally lacks observation authority. Authenticate its
   * signed birth and compare against initial and freshly observed source pins. */
  async assertOriginalSourceBirth(
    manifestPath: string,
    captureId: string,
    initial: readonly InstalledSourceObservation[],
  ): Promise<void> {
    if (!initial.length) return;
    z.uuid({ version: 'v4' }).parse(captureId);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const path = join(dirname(manifestPath), `birth-${captureId}.json`);
    const pin = readLiveConfigFile(path),
      record = JSON.parse(readFileSync(path, 'utf8'));
    const info = lstatSync(path);
    const body = record.body;
    const expected = createHmac('sha256', readFileSync(manifest.keyFile))
      .update(stable(body))
      .digest();
    const mac =
      typeof record.mac === 'string' && /^[a-f0-9]{64}$/.test(record.mac)
        ? Buffer.from(record.mac, 'hex')
        : Buffer.alloc(0);
    if (
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      mac.length !== expected.length ||
      !timingSafeEqual(mac, expected) ||
      body?.schemaVersion !== 2 ||
      body.kind !== 'before-runtime-birth' ||
      body.captureId !== captureId ||
      !isDeepStrictEqual(body.originalLaunchSources, initial) ||
      !isDeepStrictEqual(await this.observeOriginalSources(manifestPath), initial) ||
      !isDeepStrictEqual(readLiveConfigFile(path), pin)
    )
      throw new Error('LIVE_INSTALLED_SOURCE_UNVERIFIED');
  }
  contextLaunchIds(manifestPath: string): readonly string[] {
    return readdirSync(dirname(manifestPath)).filter((name) =>
      /^process-[a-f0-9-]{36}\.json$/.test(name),
    );
  }
  /** Successful tool stdout is not readiness. Require a new authenticated
   * current-generation launch that reached signed post-spawn validation. */
  assertCompletedContextLaunch(
    manifestPath: string,
    prior: readonly string[],
    policyDigest: string,
  ): void {
    const manifestPin = readLiveConfigFile(manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const key = readFileSync(manifest.keyFile);
    const valid = this.contextLaunchIds(manifestPath)
      .filter((name) => !prior.includes(name))
      .some((name) => {
        const path = join(dirname(manifestPath), name),
          pin = readLiveConfigFile(path);
        const record = JSON.parse(readFileSync(path, 'utf8')),
          body = record.body;
        const expected = createHmac('sha256', key).update(stable(body)).digest('hex');
        if (
          record.mac !== expected ||
          lstatSync(path).uid !== process.getuid?.() ||
          lstatSync(path).mode & 0o077
        )
          throw new Error('LIVE_CONTEXT_RECEIPT_UNVERIFIED');
        return (
          isDeepStrictEqual(readLiveConfigFile(path), pin) &&
          body?.kind === 'process-launch' &&
          name === `process-${body.launchId}.json` &&
          body.commandId === 'context-mode-call' &&
          body.postSpawnValidated === true &&
          body.status === 'exited' &&
          body.termination === 'leader-exit' &&
          body.policy?.policyDigest === policyDigest &&
          body.policy?.manifestDigest === manifestPin.sha256 &&
          isDeepStrictEqual(body.policy?.generation, manifest.generation) &&
          isDeepStrictEqual(
            body.policy?.commands?.['context-mode-call'],
            manifest.commands?.['context-mode-call'],
          )
        );
      });
    if (!valid || !isDeepStrictEqual(readLiveConfigFile(manifestPath), manifestPin))
      throw new Error('LIVE_CONTEXT_RECEIPT_UNVERIFIED');
  }
  /** Manager signs only for its direct elected-controller parent. These typed
   * operations never accept a command, environment, or project-provided argv. */
  private async runtimeCommand(
    manifestPath: string,
    action: 'capture-runtime' | 'renew-runtime' | 'seal-runtime' | 'revoke-runtime',
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
  renewRuntime(input: {
    manifestPath: string;
    captureId: string;
    previousManifestPath: string;
    previousCaptureId: string;
    mode: 'survivor' | 'replacement';
  }): Promise<Record<string, unknown>> {
    canonical(input.previousManifestPath);
    z.uuid({ version: 'v4' }).parse(input.previousCaptureId);
    z.enum(['survivor', 'replacement']).parse(input.mode);
    if (
      input.manifestPath === input.previousManifestPath ||
      input.captureId === input.previousCaptureId
    )
      throw new Error('LIVE_RUNTIME_RENEWAL_INVALID');
    return this.runtimeCommand(input.manifestPath, 'renew-runtime', input.captureId, [
      '--previous-manifest',
      input.previousManifestPath,
      '--previous-capture-id',
      input.previousCaptureId,
      '--mode',
      input.mode,
    ]);
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
          timeout: LIVE_MANAGER_OBSERVATION_MS + 5_000,
          maxBuffer: 16384,
        },
      );
      this.verifyInstallation();
    } catch (error) {
      throw new Error('LIVE_RUNTIME_BOOTSTRAP_UNAVAILABLE', {
        cause: InstalledLiveAdmissionError.command('manager-command', error),
      });
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
        timeout:
          (binary === this.installation.manager.path ? 1 : 2) * LIVE_MANAGER_OBSERVATION_MS + 5_000,
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
        binary === this.installation.manager.path && args.includes('--manifest')
          ? admissionPrerequisites(args[args.indexOf('--manifest') + 1]!)
          : undefined,
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
      this.assertOriginalSourceReply(manager, await this.observeOriginalSources(manifestPath));
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
