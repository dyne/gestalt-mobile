import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkoutBranch,
  inspectGit,
  parseDivergence,
  parseDirtyCounts,
  pushUpstream,
} from './git-inspector.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gestalt-mobile-git-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function configureAuthor(cwd: string): Promise<void> {
  await git(cwd, 'config', 'user.name', 'Codex Relay Test');
  await git(cwd, 'config', 'user.email', 'gestalt-mobile@example.test');
}

describe('git inspector', () => {
  it('parses git left-right divergence counts', () => {
    expect(parseDivergence('3\t2\n')).toEqual({ ahead: 3, behind: 2 });
  });
  it('counts staged, unstaged, and untracked porcelain entries', () => {
    expect(parseDirtyCounts('M  staged.ts\n M unstaged.ts\n?? new.ts\n')).toEqual({
      staged: 1,
      unstaged: 1,
      untracked: 1,
    });
  });

  it('reports a non-repository as unavailable', async () => {
    const workspace = await createTemporaryDirectory();
    await expect(inspectGit(workspace)).resolves.toMatchObject({ available: false });
  });

  it('inspects clean and dirty repositories, including Unicode paths and subjects', async () => {
    const workspace = await createTemporaryDirectory();
    await git(workspace, 'init');
    await configureAuthor(workspace);
    await writeFile(join(workspace, 'README.md'), 'initial\n');
    await writeFile(join(workspace, 'caffè.txt'), 'unicode\n');
    await git(workspace, 'add', '.');
    await git(workspace, 'commit', '-m', 'Initial ✓');

    const clean = await inspectGit(workspace);
    expect(clean).toMatchObject({
      available: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: { staged: 0, unstaged: 0, untracked: 0 },
    });
    expect(clean.branch).toEqual(expect.any(String));
    expect(clean.commits[0]).toMatchObject({ subject: 'Initial ✓', author: 'Codex Relay Test' });

    await writeFile(join(workspace, 'staged.txt'), 'staged\n');
    await git(workspace, 'add', 'staged.txt');
    await writeFile(join(workspace, 'README.md'), 'changed\n');
    await writeFile(join(workspace, 'untracked.txt'), 'untracked\n');

    await expect(inspectGit(workspace)).resolves.toMatchObject({
      available: true,
      dirty: { staged: 1, unstaged: 1, untracked: 1 },
    });
  });

  it('reports divergence from an upstream and handles detached HEAD', async () => {
    const root = await createTemporaryDirectory();
    const remote = join(root, 'remote.git');
    const local = join(root, 'local');
    const peer = join(root, 'peer');
    await git(root, 'init', '--bare', remote);
    await git(root, 'clone', remote, local);
    await configureAuthor(local);
    await writeFile(join(local, 'README.md'), 'initial\n');
    await git(local, 'add', '.');
    await git(local, 'commit', '-m', 'Initial');
    await git(local, 'push', '-u', 'origin', 'HEAD');
    await writeFile(join(local, 'pushed.txt'), 'pushed\n');
    await git(local, 'add', '.');
    await git(local, 'commit', '-m', 'Pushed commit');
    const beforePush = await inspectGit(local);
    expect(beforePush).toMatchObject({ ahead: 1, behind: 0, upstream: expect.any(String) });
    await pushUpstream(local, beforePush.upstream!);
    await expect(inspectGit(local)).resolves.toMatchObject({ ahead: 0, behind: 0 });
    await git(root, 'clone', remote, peer);
    await configureAuthor(peer);
    await writeFile(join(peer, 'peer.txt'), 'peer\n');
    await git(peer, 'add', '.');
    await git(peer, 'commit', '-m', 'Peer commit');
    await git(peer, 'push');
    await git(local, 'fetch', 'origin');
    await writeFile(join(local, 'local.txt'), 'local\n');
    await git(local, 'add', '.');
    await git(local, 'commit', '-m', 'Local commit');

    const divergent = await inspectGit(local);
    expect(divergent).toMatchObject({
      available: true,
      upstream: expect.stringMatching(/^origin\//),
      ahead: 1,
      behind: 1,
    });
    await expect(pushUpstream(local, divergent.upstream!)).rejects.toThrow();

    await git(local, 'checkout', '--detach');
    await expect(inspectGit(local)).resolves.toMatchObject({
      available: true,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
    });
  });

  it('lists and checks out local branches only', async () => {
    const workspace = await createTemporaryDirectory();
    await git(workspace, 'init');
    await configureAuthor(workspace);
    await writeFile(join(workspace, 'README.md'), 'initial\n');
    await git(workspace, 'add', '.');
    await git(workspace, 'commit', '-m', 'Initial');
    await git(workspace, 'branch', 'topic');

    await expect(inspectGit(workspace)).resolves.toMatchObject({
      branches: expect.arrayContaining(['topic']),
    });
    await checkoutBranch(workspace, 'topic');
    await expect(inspectGit(workspace)).resolves.toMatchObject({ branch: 'topic' });
    await expect(checkoutBranch(workspace, 'origin/topic')).rejects.toThrow(
      'LOCAL_BRANCH_NOT_FOUND',
    );
  });
});
