/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { liveSourceDigest } from './owning-source-inventory.js';

const text = z.string().min(1).max(4096);
const path = text.refine((value) => isAbsolute(value) && normalize(value) === value);
const approval = z.union([
  z.enum(['never', 'untrusted', 'on-request']),
  z.strictObject({
    granular: z.strictObject({
      sandbox_approval: z.boolean(),
      rules: z.boolean(),
      skill_approval: z.boolean(),
      request_permissions: z.boolean(),
      mcp_elicitations: z.boolean(),
    }),
  }),
]);
const sandbox = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('dangerFullAccess') }),
  z.strictObject({ type: z.literal('readOnly'), networkAccess: z.boolean() }),
  z.strictObject({
    type: z.literal('externalSandbox'),
    networkAccess: z.enum(['enabled', 'restricted']),
  }),
  z.strictObject({
    type: z.literal('workspaceWrite'),
    writableRoots: z.array(path),
    networkAccess: z.boolean(),
    excludeTmpdirEnvVar: z.boolean(),
    excludeSlashTmp: z.boolean(),
  }),
]);
const flags = z.strictObject({
  model: text,
  modelProvider: text,
  cwd: path,
  approvalPolicy: approval,
  activePermissionProfile: z.strictObject({ id: text, extends: text.nullable() }),
  sandbox,
  reasoningEffort: text.nullable(),
  runtimeWorkspaceRoots: z.array(path).optional(),
  instructionSources: z.array(path).optional(),
});
const accountResponse = z.strictObject({
  account: z.unknown(),
  requiresOpenaiAuth: z.boolean(),
  workspaceRouting: z.null().optional(),
});
const chatgptAccount = z.strictObject({
  type: z.literal('chatgpt'),
  email: text,
  planType: z.enum([
    'free',
    'go',
    'plus',
    'pro',
    'prolite',
    'promax',
    'team',
    'self_serve_business_prolite',
    'self_serve_business_usage_based',
    'business',
    'ent26',
    'enterprise_cbp_automation',
    'enterprise_cbp_usage_based',
    'enterprise',
    'edu',
    'edu_plus',
    'edu_pro',
    'unknown',
  ]),
});
export type OwningNativeObservation = Readonly<{
  sessionFlags: Readonly<z.infer<typeof flags>>;
  accountDigest: string;
}>;

/** Only actual private Native responses enter here. Account profile data never
 * leaves this producer; the signed inventory contains its opaque digest only.
 * Native apiKey/Bedrock summaries expose no account identity and cannot prove
 * renewal identity without inventing one or hashing a credential, so refuse.
 */
export function observeOwningNative(input: {
  configuration: unknown;
  selection: Readonly<Record<string, unknown>> | null;
  account: unknown;
}): OwningNativeObservation {
  try {
    if (!input.selection) throw new Error();
    const selection = { ...input.selection };
    delete selection.threadId;
    const sessionFlags = flags.parse(selection);
    const account = accountResponse.parse(input.account);
    if (!Object.hasOwn(account, 'account')) throw new Error();
    let accountId: unknown;
    if (account.account === null) {
      const config = z
        .object({ config: z.record(z.string(), z.unknown()) })
        .parse(input.configuration).config;
      const providers = z.record(z.string(), z.unknown()).parse(config.model_providers);
      const provider = z
        .object({ requires_openai_auth: z.literal(false) })
        .parse(providers[sessionFlags.modelProvider]);
      if (account.requiresOpenaiAuth || provider.requires_openai_auth !== false) throw new Error();
      accountId = null;
    } else {
      accountId = chatgptAccount.parse(account.account);
      if (!account.requiresOpenaiAuth) throw new Error();
    }
    return Object.freeze({
      sessionFlags: Object.freeze(structuredClone(sessionFlags)),
      accountDigest: liveSourceDigest({ providerId: sessionFlags.modelProvider, accountId }),
    });
  } catch {
    throw new Error('LIVE_OWNING_OBSERVATION_UNVERIFIED');
  }
}
