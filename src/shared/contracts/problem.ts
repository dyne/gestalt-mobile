export type ProblemDetail = {
  type: `urn:codex-relay:error:${string}`;
  title: string;
  status: number;
  detail: string;
  code: string;
  retryable: boolean;
  fieldErrors?: Record<string, string[]>;
};
