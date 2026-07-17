import { GIT_FETCH_TIMEOUT_MS, git } from './command.js';

export type WorkspaceGitSummary = {
  available: boolean;
  branch: string | null;
  branches?: string[];
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: { staged: number; unstaged: number; untracked: number };
  commits: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    authoredAt: string;
  }>;
  fetchedAt: string | null;
};

export function parseDirtyCounts(value: string): {
  staged: number;
  unstaged: number;
  untracked: number;
} {
  return value
    .split('\n')
    .filter(Boolean)
    .reduce(
      (counts, line) => ({
        staged: counts.staged + (line[0] && line[0] !== ' ' && line.slice(0, 2) !== '??' ? 1 : 0),
        unstaged:
          counts.unstaged + (line.slice(0, 2) !== '??' && line[1] && line[1] !== ' ' ? 1 : 0),
        untracked: counts.untracked + (line.slice(0, 2) === '??' ? 1 : 0),
      }),
      { staged: 0, unstaged: 0, untracked: 0 },
    );
}

export function parseDivergence(value: string): { ahead: number; behind: number } {
  const [ahead, behind] = value.trim().split(/\s+/).map(Number);
  return {
    ahead: Number.isSafeInteger(ahead) ? ahead : 0,
    behind: Number.isSafeInteger(behind) ? behind : 0,
  };
}

export async function inspectGit(cwd: string): Promise<WorkspaceGitSummary> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    const branch = await git(cwd, ['branch', '--show-current']).then(
      (value) => value.trim() || null,
    );
    const branches = (await git(cwd, ['branch', '--format=%(refname:short)']))
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean);
    const upstream = branch
      ? await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
          .then((value) => value.trim())
          .catch(() => null)
      : null;
    const divergence = upstream
      ? parseDivergence(
          await git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
        )
      : { ahead: 0, behind: 0 };
    const dirty = parseDirtyCounts(await git(cwd, ['status', '--porcelain=v1']));
    const commits = (await git(cwd, ['log', '-20', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI']))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, subject, author, authoredAt] = line.split('\x1f');
        return {
          hash: hash!,
          shortHash: shortHash!,
          subject: subject!,
          author: author!,
          authoredAt: authoredAt!,
        };
      });
    return { available: true, branch, branches, upstream, ...divergence, dirty, commits, fetchedAt: null };
  } catch {
    return {
      available: false,
      branch: null,
      branches: [],
      upstream: null,
      ahead: 0,
      behind: 0,
      dirty: { staged: 0, unstaged: 0, untracked: 0 },
      commits: [],
      fetchedAt: null,
    };
  }
}

export async function pushUpstream(cwd: string, upstream: string): Promise<void> {
  const separator = upstream.indexOf('/');
  if (separator < 1 || separator === upstream.length - 1) throw new Error('NO_UPSTREAM');
  await git(cwd, [
    'push',
    upstream.slice(0, separator),
    `HEAD:refs/heads/${upstream.slice(separator + 1)}`,
  ]);
}

export async function fetchUpstream(cwd: string): Promise<void> {
  const upstream = await git(cwd, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const remote = upstream.trim().split('/')[0];
  if (!remote) throw new Error('NO_UPSTREAM');
  await git(cwd, ['fetch', '--prune', remote], GIT_FETCH_TIMEOUT_MS);
}

export async function pullRebase(cwd: string): Promise<void> {
  await git(cwd, ['pull', '--rebase'], GIT_FETCH_TIMEOUT_MS);
}

export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  const branches = (await git(cwd, ['branch', '--format=%(refname:short)']))
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!branches.includes(branch)) throw new Error('LOCAL_BRANCH_NOT_FOUND');
  await git(cwd, ['switch', branch]);
}
