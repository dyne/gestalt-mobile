/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import type { SkillProvenanceVerifier } from '../../features/skills/application/ports.js';
import type { SkillProvenance } from '../../features/skills/model/skill-profile.js';

const repository = 'dyne/gestalt-skills';
const source = 'https://github.com/dyne/gestalt-skills';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bundledFile = z.object({ path: z.string().min(1).max(512), sha256: digest }).strict();
const collectionSkill = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(63),
    entry: z.string().min(1).max(512),
    files: z.array(bundledFile).min(1).max(4096),
  })
  .strict();
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.literal(repository),
    source: z.literal(source),
    version: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/),
    skills: z.array(collectionSkill).min(1).max(256),
  })
  .strict();
const receiptSchema = manifestSchema
  .omit({ source: true })
  .extend({
    source: z.literal(source),
    revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    manifestSha256: digest,
    managedRoot: z.string(),
    discoveryRoot: z.string(),
    verifiedSource: z.literal(true),
    packageFiles: z.array(bundledFile).length(1),
    installedAt: z.iso.datetime(),
    transactionId: z.string().regex(/^[a-f0-9]{48}$/),
  })
  .strict();

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function ordinaryBytes(path: string, limit: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > limit) throw new Error('Invalid managed file.');
  return readFile(path);
}

function json(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // JSON.parse enforces JSON syntax; the YAML reader additionally rejects
  // duplicate decoded mapping keys, including JSON escape spellings.
  const value: unknown = JSON.parse(text);
  if (parseDocument(text, { strict: true, uniqueKeys: true }).errors.length)
    throw new Error('Invalid managed JSON.');
  return value;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function bundledPath(root: string, path: string): string {
  if (path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error('Invalid bundled path.');
  const absolute = resolve(root, path);
  if (!inside(root, absolute) || isAbsolute(path)) throw new Error('Invalid bundled path.');
  return absolute;
}

async function inventory(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await inventory(path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error('Invalid managed inventory.');
  }
  return result.sort();
}

/**
 * Trust only the configured home, never a root inferred from a discovered path.
 * Verification is local provenance/integrity, not protection against an owner
 * replacing both the package and its installer receipt. No state is cached.
 */
export class ManagedSkillProvenance implements SkillProvenanceVerifier {
  constructor(private readonly codexHome: string) {}

  async verify(paths: readonly string[]): Promise<ReadonlyMap<string, SkillProvenance>> {
    const verified = new Map<string, SkillProvenance>();
    if (!paths.length) return verified;
    try {
      const home = await realpath(this.codexHome);
      const root = join(home, 'gestalt-skills');
      const discovery = join(home, 'skills');
      // Home aliases are supported; the collection/discovery roots themselves
      // must be the installer-owned locations, not links to arbitrary copies.
      if ((await realpath(root)) !== root || (await realpath(discovery)) !== discovery)
        return verified;
      const manifestBytes = await ordinaryBytes(join(root, 'manifest.json'), 2 * 1024 * 1024);
      const receipt = receiptSchema.parse(
        json(await ordinaryBytes(join(root, 'receipt.json'), 2 * 1024 * 1024)),
      );
      const manifest = manifestSchema.parse(json(manifestBytes));
      if (
        receipt.managedRoot !== root ||
        receipt.discoveryRoot !== discovery ||
        receipt.manifestSha256 !== sha256(manifestBytes) ||
        receipt.version !== manifest.version ||
        JSON.stringify(receipt.skills) !== JSON.stringify(manifest.skills) ||
        receipt.packageFiles[0].path !== 'LICENSE'
      )
        return verified;
      const expected: string[] = [];
      const entries = new Set<string>();
      const names = manifest.skills.map((skill) => skill.name);
      if (names.join('\n') !== [...new Set(names)].sort().join('\n')) return verified;
      for (const skill of manifest.skills) {
        if (skill.entry !== `skills/${skill.name}/SKILL.md`) return verified;
        const entry = bundledPath(root, skill.entry);
        entries.add(entry);
        const skillRoot = join(root, 'skills', skill.name);
        const filePaths = skill.files.map((file) => file.path);
        if (
          !filePaths.includes(skill.entry) ||
          filePaths.join('\n') !== [...new Set(filePaths)].sort().join('\n')
        )
          return verified;
        for (const file of skill.files) {
          const path = bundledPath(root, file.path);
          if (!inside(skillRoot, path) || (await realpath(path)) !== path) return verified;
          if (sha256(await ordinaryBytes(path, 16 * 1024 * 1024)) !== file.sha256) return verified;
          expected.push(path);
        }
      }
      if (JSON.stringify(await inventory(join(root, 'skills'))) !== JSON.stringify(expected.sort()))
        return verified;
      const license = receipt.packageFiles[0];
      if (
        sha256(await ordinaryBytes(join(root, license.path), 16 * 1024 * 1024)) !== license.sha256
      )
        return verified;
      // Resolve aliases only after validating the trusted installation. The
      // returned map retains each provider's existing path identity.
      for (const path of paths) {
        try {
          if (isAbsolute(path) && entries.has(await realpath(path)))
            verified.set(path, {
              kind: 'gestalt-verified',
              repository,
              revision: receipt.revision,
            });
        } catch {
          /* Removed/unreadable skills remain ordinary discovery metadata. */
        }
      }
    } catch {
      /* Optional receipts must never make ordinary skill discovery unusable. */
    }
    return verified;
  }
}
