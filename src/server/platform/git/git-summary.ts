export type GitSummary = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  canPush: boolean;
};
export function toGitSummary(input: {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}): GitSummary {
  return { ...input, canPush: Boolean(input.upstream) && input.ahead > 0 };
}
