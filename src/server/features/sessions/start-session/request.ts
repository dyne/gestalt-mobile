import { z } from 'zod';

const schema = z.object({
  workspaceId: z.string().min(1),
  profile: z.string().min(1),
  model: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
});

export type StartSessionRequest = z.infer<typeof schema>;

/** Parses only settings that are safe to send directly to Codex thread/start. */
export function parseStartSessionRequest(input: unknown): StartSessionRequest | null {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
}
