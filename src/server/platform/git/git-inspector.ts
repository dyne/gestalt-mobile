import { git } from './command.js';

export type WorkspaceGitSummary = {
  available: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  commits: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    authoredAt: string;
  }>;
};

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
    return { available: true, branch, upstream, ...divergence, commits };
  } catch {
    return { available: false, branch: null, upstream: null, ahead: 0, behind: 0, commits: [] };
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
  await git(cwd, ['fetch', '--prune', remote]);
}
