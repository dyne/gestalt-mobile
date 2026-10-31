/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManagedSkillProvenance } from './managed-skill-provenance.js';
import { CachedSkillCatalog } from './cached-skill-catalog.js';
import { VerifiedSkillCatalog } from './verified-skill-catalog.js';

const revision = 'a'.repeat(40);
const provenance = {
  kind: 'gestalt-verified' as const,
  repository: 'dyne/gestalt-skills' as const,
  revision,
};
const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'managed-skill-provenance-'));
  roots.push(home);
  const root = join(home, 'gestalt-skills');
  const discovery = join(home, 'skills');
  const entry = join(root, 'skills/nuklear-gui/SKILL.md');
  const reference = join(root, 'skills/nuklear-gui/references/guide.md');
  const files = [
    { path: 'skills/nuklear-gui/SKILL.md', content: '---\nname: nuklear-gui\n---\nGuidance\n' },
    { path: 'skills/nuklear-gui/references/guide.md', content: 'Reference\n' },
  ];
  for (const file of files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
  await writeFile(join(root, 'LICENSE'), 'License\n');
  await mkdir(discovery);
  await symlink(join(root, 'skills/nuklear-gui'), join(discovery, 'nuklear-gui'));
  const manifest = {
    schemaVersion: 1,
    repository: 'dyne/gestalt-skills',
    source: 'https://github.com/dyne/gestalt-skills',
    version: '0.1.0',
    skills: [
      {
        name: 'nuklear-gui',
        entry: files[0].path,
        files: files.map(({ path, content }) => ({ path, sha256: hash(content) })),
      },
    ],
  };
  const manifestBytes = JSON.stringify(manifest);
  const receipt = {
    ...manifest,
    revision,
    manifestSha256: hash(manifestBytes),
    managedRoot: root,
    discoveryRoot: discovery,
    verifiedSource: true,
    packageFiles: [{ path: 'LICENSE', sha256: hash('License\n') }],
    installedAt: '2026-10-31T00:00:00.000Z',
    transactionId: 'b'.repeat(48),
  };
  const saveReceipt = () => writeFile(join(root, 'receipt.json'), JSON.stringify(receipt));
  await writeFile(join(root, 'manifest.json'), manifestBytes);
  await saveReceipt();
  return {
    home,
    root,
    entry,
    reference,
    discovery,
    manifest,
    receipt,
    saveReceipt,
    verifier: new ManagedSkillProvenance(home),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ManagedSkillProvenance', () => {
  it('verifies canonical entries and discovery/home aliases without changing path identity', async () => {
    const f = await fixture();
    const alias = join(f.discovery, 'nuklear-gui/SKILL.md');
    const homeAlias = `${f.home}-alias`;
    roots.push(homeAlias);
    await symlink(f.home, homeAlias);
    expect(await new ManagedSkillProvenance(homeAlias).verify([f.entry, alias])).toEqual(
      new Map([
        [f.entry, provenance],
        [alias, provenance],
      ]),
    );
  });

  it('keeps equal-name user skills, prefix siblings, copied receipts and references ordinary', async () => {
    const f = await fixture();
    const sibling = join(f.home, 'gestalt-skills-copy');
    const user = join(f.home, 'user/nuklear-gui/SKILL.md');
    const copied = join(sibling, 'skills/nuklear-gui/SKILL.md');
    for (const path of [user, copied]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, await readFile(f.entry));
    }
    await writeFile(join(sibling, 'receipt.json'), JSON.stringify(f.receipt));
    expect(await f.verifier.verify([user, copied, f.reference, f.entry])).toEqual(
      new Map([[f.entry, provenance]]),
    );
    expect(
      await new ManagedSkillProvenance(join(f.home, 'unconfigured')).verify([f.entry]),
    ).toEqual(new Map());
  });

  it.each([
    'missing receipt',
    'corrupt receipt',
    'duplicate receipt key',
    'duplicate manifest key',
    'changed entry',
    'changed reference',
    'removed skill',
    'added file',
    'changed manifest',
    'changed license',
    'override source',
    'explicit canonical override',
    'wrong root',
    'wrong discovery root',
    'wrong revision',
    'wrong manifest digest',
    'receipt inventory mismatch',
  ])('loses verification for %s while keeping ordinary catalog entries', async (scenario) => {
    const f = await fixture();
    switch (scenario) {
      case 'missing receipt':
        await rm(join(f.root, 'receipt.json'));
        break;
      case 'corrupt receipt':
        await writeFile(join(f.root, 'receipt.json'), '{');
        break;
      case 'duplicate receipt key':
        await writeFile(
          join(f.root, 'receipt.json'),
          JSON.stringify(f.receipt).replace(
            '"verifiedSource":true',
            '"verifiedSource":false,"verified\\u0053ource":true',
          ),
        );
        break;
      case 'duplicate manifest key': {
        const bytes = JSON.stringify(f.manifest).replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1',
        );
        await writeFile(join(f.root, 'manifest.json'), bytes);
        f.receipt.manifestSha256 = hash(bytes);
        await f.saveReceipt();
        break;
      }
      case 'changed entry':
        await writeFile(f.entry, 'changed');
        break;
      case 'changed reference':
        await writeFile(f.reference, 'changed');
        break;
      case 'removed skill':
        await rm(dirname(f.entry), { recursive: true });
        break;
      case 'added file':
        await writeFile(join(dirname(f.entry), 'extra.md'), 'extra');
        break;
      case 'changed manifest':
        await writeFile(join(f.root, 'manifest.json'), '{}');
        break;
      case 'changed license':
        await writeFile(join(f.root, 'LICENSE'), 'changed');
        break;
      case 'override source':
        f.receipt.source = '/tmp/local-override';
        await f.saveReceipt();
        break;
      case 'explicit canonical override':
        f.receipt.verifiedSource = false;
        await f.saveReceipt();
        break;
      case 'wrong root':
        f.receipt.managedRoot = `${f.root}-copy`;
        await f.saveReceipt();
        break;
      case 'wrong discovery root':
        f.receipt.discoveryRoot = `${f.discovery}-copy`;
        await f.saveReceipt();
        break;
      case 'wrong revision':
        f.receipt.revision = 'main';
        await f.saveReceipt();
        break;
      case 'wrong manifest digest':
        f.receipt.manifestSha256 = '0'.repeat(64);
        await f.saveReceipt();
        break;
      case 'receipt inventory mismatch':
        f.receipt.skills = [];
        await f.saveReceipt();
        break;
    }
    const ordinary = { name: 'nuklear-gui', path: f.entry, enabled: false };
    const catalog = new VerifiedSkillCatalog(
      { list: async () => ({ skills: [ordinary], errors: [] }) },
      f.verifier,
    );
    expect(await catalog.list('/workspace')).toEqual({ skills: [ordinary], errors: [] });
  });

  it.each(['escaping file', 'escaping directory', 'managed root', 'receipt link'])(
    'rejects an %s symlink even when bytes and receipt match',
    async (scenario) => {
      const f = await fixture();
      const outside = join(f.home, 'outside');
      if (scenario === 'managed root') {
        await rename(f.root, outside);
        await symlink(outside, f.root);
      } else if (scenario === 'escaping directory') {
        await rename(dirname(f.reference), outside);
        await symlink(outside, dirname(f.reference));
      } else {
        const target = scenario === 'receipt link' ? join(f.root, 'receipt.json') : f.reference;
        await rename(target, outside);
        await symlink(outside, target);
      }
      expect(await f.verifier.verify([f.entry])).toEqual(new Map());
    },
  );

  it.each([
    'entry outside skill',
    'entry missing from files',
    'duplicate file',
    'file outside skill',
    'traversal file',
    'wrong manifest source',
    'wrong manifest repository',
  ])('rejects %s even with matching receipt and manifest digest', async (scenario) => {
    const f = await fixture();
    const skill = f.manifest.skills[0];
    switch (scenario) {
      case 'entry outside skill':
        skill.entry = 'skills/other/SKILL.md';
        break;
      case 'entry missing from files':
        skill.files.shift();
        break;
      case 'duplicate file':
        skill.files.push(skill.files[0]);
        break;
      case 'file outside skill':
        skill.files[1].path = 'skills/nuklear-gui-copy/guide.md';
        break;
      case 'traversal file':
        skill.files[1].path = 'skills/nuklear-gui/../outside.md';
        break;
      case 'wrong manifest source':
        f.manifest.source = 'https://example.test/gestalt-skills';
        break;
      case 'wrong manifest repository':
        f.manifest.repository = 'other/gestalt-skills';
        break;
    }
    const bytes = JSON.stringify(f.manifest);
    await writeFile(join(f.root, 'manifest.json'), bytes);
    f.receipt.manifestSha256 = hash(bytes);
    await f.saveReceipt();
    expect(await f.verifier.verify([f.entry])).toEqual(new Map());
  });

  it('ignores forged provider/frontmatter metadata and preserves duplicate-name enabled states', async () => {
    const f = await fixture();
    const ordinary = {
      name: 'nuklear-gui',
      path: '/user/nuklear-gui/SKILL.md',
      enabled: true,
      provenance,
    };
    const catalog = new VerifiedSkillCatalog(
      {
        list: async () => ({
          skills: [ordinary, { ...ordinary, path: f.entry, enabled: false }],
          errors: [],
        }),
      },
      f.verifier,
    );
    const result = await catalog.list('/workspace');
    expect(result.skills).toEqual([
      { name: ordinary.name, path: ordinary.path, enabled: true },
      { ...ordinary, path: f.entry, enabled: false },
    ]);
    // Even matching frontmatter claims are content changes, not authority.
    await writeFile(
      f.entry,
      `---\nname: nuklear-gui\nprovenance: ${JSON.stringify(provenance)}\n---\n`,
    );
    expect((await catalog.list('/workspace')).skills.every((skill) => !skill.provenance)).toBe(
      true,
    );
  });

  it('revalidates cached reads after edits, updates and removal without changing enabled states', async () => {
    const f = await fixture();
    let present = true;
    const discover = vi.fn(async () => ({
      skills: present ? [{ name: 'nuklear-gui', path: f.entry, enabled: false, provenance }] : [],
      errors: [],
    }));
    const cached = new CachedSkillCatalog(discover, undefined, f.verifier);
    expect((await cached.refresh('codex', 'default', '/workspace')).skills[0].provenance).toEqual(
      provenance,
    );
    const original = await readFile(f.reference);
    await writeFile(f.reference, 'edit');
    expect((await cached.list('codex', 'default', '/workspace')).skills[0]).toEqual({
      name: 'nuklear-gui',
      path: f.entry,
      enabled: false,
    });
    await writeFile(f.reference, original);
    f.receipt.revision = 'c'.repeat(40);
    await f.saveReceipt();
    expect(
      (await cached.list('codex', 'default', '/workspace')).skills[0].provenance?.revision,
    ).toBe(f.receipt.revision);
    await rm(f.entry);
    expect(
      (await cached.list('codex', 'default', '/workspace')).skills[0].provenance,
    ).toBeUndefined();
    present = false;
    expect((await cached.refresh('codex', 'default', '/workspace')).skills).toEqual([]);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
