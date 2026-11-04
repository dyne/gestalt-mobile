/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ManagedPlaywright } from './managed-playwright.js';

it('resolves doctor readiness only after its real private process group is absent', async () => {
  const base = join(process.cwd(), 'tmp', 'mobile-scratch-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'doctor-release-'));
  const manager = join(root, 'doctor.mjs');
  const pid = join(root, 'pid');
  try {
    await writeFile(
      manager,
      `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pid)},String(process.pid));
console.log(JSON.stringify({schemaVersion:1,contractVersion:1,ready:true,package:{ready:true},chrome:{ready:true,version:'151.0.1'},node:{ready:true}}));
`,
      { mode: 0o700 },
    );
    const readiness = await new ManagedPlaywright({ PATH: process.env.PATH }).ready(
      manager,
      root,
      Date.now() + 3000,
    );
    expect(readiness.ready).toBe(true);
    const group = -Number(await readFile(pid, 'utf8'));
    expect(() => process.kill(group, 0)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
