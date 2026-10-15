/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import { installationSchema } from './installed-policy.js';
import { readLiveConfigFile, type LiveConfigFile } from './effective-config.js';
import { LIVE_CODEX_BWRAP_SHA256, LIVE_CODEX_SHA256 } from './native-contract.js';
import { LIVE_HELPER_BINARY_SHA256 } from './helper-process.js';

const pin = z
  .object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const port = z.number().int().min(1024).max(65535);
const nativeState = z
  .object({
    permissionProfile: z
      .object({
        type: z.literal('managed'),
        file_system: z
          .object({
            type: z.literal('restricted'),
            entries: z
              .array(
                z
                  .object({
                    path: z.union([
                      z.object({ type: z.literal('path'), path: z.string() }).strict(),
                      z.object({ type: z.literal('glob_pattern'), pattern: z.string() }).strict(),
                      z
                        .object({
                          type: z.literal('special'),
                          value: z.object({ kind: z.string() }).strict(),
                        })
                        .strict(),
                    ]),
                    access: z.enum(['read', 'write', 'deny']),
                  })
                  .strict(),
              )
              .min(1)
              .max(256),
          })
          .strict(),
        network: z.enum(['restricted', 'enabled']),
      })
      .strict(),
    sandboxCwd: z.string(),
    useLegacyLandlock: z.literal(false),
  })
  .strict();
const schema = z
  .object({
    schemaVersion: z.literal(1),
    privateDirectory: z.string(),
    installation: installationSchema,
    mobile: z.object({ root: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    native: pin.extend({ sha256: z.literal(LIVE_CODEX_SHA256) }),
    nativeEnvironment: z
      .object({
        PATH: z.string(),
        HOME: z.string(),
        CODEX_HOME: z.string(),
        TMPDIR: z.string(),
        LANG: z.literal('C.UTF-8'),
      })
      .strict(),
    providerCredentialEnvironment: z
      .array(z.enum(['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']))
      .max(3)
      .default([]),
    project: z
      .object({
        bwrap: pin.extend({ sha256: z.literal(LIVE_CODEX_BWRAP_SHA256) }),
        node: pin,
        worker: pin,
        helper: pin.extend({ sha256: z.literal(LIVE_HELPER_BINARY_SHA256) }),
      })
      .strict(),
    components: z
      .object({
        manager: z.string().min(1).max(128),
        mobile: z.string().min(1).max(128),
        agents: z.string().min(1).max(128),
      })
      .strict(),
    caddy: z
      .object({
        controllerDirectory: z.string(),
        socketPath: z.string(),
        credentialPath: z.string(),
        hostname: z.string(),
        previewPorts: z.array(port).min(1).max(32),
      })
      .strict(),
    apps: z
      .array(
        z
          .object({
            appId: identity,
            targetId: identity,
            appRoot: z.string(),
            workspaceRoot: z.string(),
            plans: z.array(z.string()).max(32),
            // Private host expectation, checked against the actual original
            // config/selection after birth. It never substitutes for observation.
            owningPolicy: z
              .object({
                profileId: z.string().min(1).max(128),
                sandboxState: nativeState,
                configFiles: z.array(pin).min(1).max(64),
                instructionFiles: z.array(z.string()).max(64).default([]),
              })
              .strict()
              .optional(),
            helperPort: port,
            gatewayPort: port,
            devserver: z
              .object({
                executable: pin,
                argv: z.array(z.string()).max(64),
                environment: z.record(z.string(), z.string()),
                launchInputs: z.array(pin).max(128),
                port,
                cacheDirectories: z
                  .array(
                    z.enum([
                      '.svelte-kit',
                      '.vite',
                      '.next',
                      '.nuxt',
                      '.astro',
                      '.cache',
                      'node_modules/.vite',
                    ]),
                  )
                  .max(7)
                  .default([]),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type ProductionLiveConfiguration = z.infer<typeof schema>;

export function readProductionLiveConfiguration(path: string): {
  configuration: ProductionLiveConfiguration;
  source: LiveConfigFile;
} {
  try {
    const source = readLiveConfigFile(path);
    const stat = lstatSync(path),
      directory = lstatSync(dirname(path));
    if (
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700
    )
      throw new Error();
    const configuration = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (readLiveConfigFile(path).sha256 !== source.sha256) throw new Error();
    const privateRoot = configuration.privateDirectory;
    const privateStat = lstatSync(privateRoot);
    if (
      !isAbsolute(privateRoot) ||
      realpathSync(privateRoot) !== privateRoot ||
      !privateStat.isDirectory() ||
      privateStat.uid !== process.getuid?.() ||
      (privateStat.mode & 0o777) !== 0o700
    )
      throw new Error();
    if (
      new Set(configuration.apps.map((app) => app.appId)).size !== configuration.apps.length ||
      new Set(configuration.apps.map((app) => app.targetId)).size !== configuration.apps.length
    )
      throw new Error();
    for (const app of configuration.apps) {
      const appRoot = realpathSync(app.appRoot),
        workspaceRoot = realpathSync(app.workspaceRoot);
      if (
        appRoot !== app.appRoot ||
        workspaceRoot !== app.workspaceRoot ||
        !lstatSync(appRoot).isDirectory()
      )
        throw new Error();
      const tail = relative(appRoot, privateRoot);
      if (!tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`)))
        throw new Error();
      for (const protectedInput of [
        path,
        configuration.nativeEnvironment.CODEX_HOME,
        configuration.mobile.root,
        configuration.installation.manager.path,
        configuration.installation.node.path,
        configuration.installation.runtime.root,
        ...configuration.installation.packages.map((entry) => entry.root),
      ]) {
        const sourceTail = relative(appRoot, protectedInput);
        if (
          !sourceTail ||
          (!isAbsolute(sourceTail) && sourceTail !== '..' && !sourceTail.startsWith(`..${sep}`))
        )
          throw new Error();
      }
      const workspaceTail = relative(workspaceRoot, appRoot);
      if (
        isAbsolute(workspaceTail) ||
        workspaceTail === '..' ||
        workspaceTail.startsWith(`..${sep}`)
      )
        throw new Error();
      if (new Set([app.devserver.port, app.helperPort, app.gatewayPort]).size !== 3)
        throw new Error();
    }
    return { configuration, source };
  } catch {
    throw new Error('LIVE_PRODUCTION_CONFIGURATION_UNAVAILABLE');
  }
}
