/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Real manager update lifecycle with an explicit, filesystem-only acquisition
 * fixture. Existing verified package bytes are copied into a disposable home;
 * original prepared releases and the external Chrome installation remain read-only.
 * Staging, integrity checks, upstream help/catalog and atomic activation are real.
 */
export async function prepareOfflineUpdate(input: {
  manager: string;
  preparedHome: string;
  fromHome: string;
  directory: string;
  path: string;
}) {
  const metadata = JSON.parse(
    await readFile(join(input.preparedHome, 'playwright/active.json'), 'utf8'),
  ) as { version: string; release: string; integrity: string };
  const initial = JSON.parse(
    await readFile(join(input.fromHome, 'playwright/active.json'), 'utf8'),
  ) as { version: string; release: string };
  const home = join(input.directory, 'disposable-managed');
  const root = join(home, 'playwright');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const seed = join(root, `release-${initial.version}-offline-seed`);
  await cp(initial.release, seed, { recursive: true, verbatimSymlinks: true });
  await writeFile(join(root, 'active.json'), JSON.stringify({ ...initial, release: seed }) + '\n', {
    mode: 0o600,
  });
  const bin = join(input.directory, 'explicit-offline-updater');
  await mkdir(bin);
  const log = join(input.directory, 'explicit-offline-update.jsonl');
  await writeFile(
    join(bin, 'npm'),
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const seed=${JSON.stringify(metadata.release)},log=${JSON.stringify(log)},version=${JSON.stringify(metadata.version)},integrity=${JSON.stringify(metadata.integrity)};
const args=process.argv.slice(2);
if(process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD!=='1'||process.env.npm_config_ignore_scripts!=='true')process.exit(90);
fs.appendFileSync(log,JSON.stringify({action:args[0],scriptsDisabled:true,browserDownloadsDisabled:true})+'\\n');
if(args[0]==='view'&&args[1]==='@playwright/mcp@'+version){console.log(JSON.stringify({version,dist:{integrity}}));}
else if(args[0]==='install'&&args.includes('--package-lock-only'))fs.copyFileSync(path.join(seed,'package-lock.json'),path.join(process.cwd(),'package-lock.json'));
else if(args[0]==='ci')fs.cpSync(path.join(seed,'node_modules'),path.join(process.cwd(),'node_modules'),{recursive:true,verbatimSymlinks:true});
else process.exit(91);
`,
    { mode: 0o700 },
  );
  const active = async () =>
    JSON.parse(await readFile(join(root, 'active.json'), 'utf8')) as {
      version: string;
      release: string;
    };
  return {
    home,
    version: metadata.version,
    fromVersion: initial.version,
    async update() {
      const before = await active();
      const child = spawn(input.manager, ['playwright', 'update', metadata.version], {
        cwd: input.directory,
        env: { ...process.env, GESTALT_HOME: home, PATH: `${bin}:${input.path}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output = (output + data).slice(-2048);
      });
      child.stderr.on('data', (data) => {
        output = (output + data).slice(-2048);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        });
        if (code !== 0)
          throw new Error(`Explicit offline fixture package update failed (${code}): ${output}`);
      } finally {
        clearTimeout(timer);
      }
      const after = await active();
      const actions = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { action: string }).action);
      if (JSON.stringify(actions) !== JSON.stringify(['view', 'install', 'ci']))
        throw new Error('Unexpected offline acquisition sequence');
      return {
        beforeVersion: before.version,
        afterVersion: after.version,
        releaseChanged: before.release !== after.release,
        acquisition: 'explicit-offline-copy-of-prepared-package',
        actions,
      };
    },
  };
}
