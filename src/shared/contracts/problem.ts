export type ProblemDetail = {
  type: `urn:gestalt-mobile:error:${string}`;
  title: string;
  status: number;
  detail: string;
  code: string;
  retryable: boolean;
  fieldErrors?: Record<string, string[]>;
};
