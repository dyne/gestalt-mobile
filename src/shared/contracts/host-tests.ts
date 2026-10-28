/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';
import { AUTOPILOT_WAIT_MIN_MS, AUTOPILOT_WAIT_MAX_MS } from './autopilot-wait-lease.js';

const suite = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const runId = z.string().uuid();
export const hostTestRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('inspect'), suite }).strict(),
  z
    .object({
      operation: z.literal('start'),
      suite,
      requestId: runId,
    })
    .strict(),
  z.object({ operation: z.literal('status'), runId }).strict(),
  z.object({ operation: z.literal('cancel'), runId }).strict(),
  z
    .object({
      operation: z.literal('wait'),
      runId,
      maxWaitMs: z
        .number()
        .int()
        .min(AUTOPILOT_WAIT_MIN_MS)
        .max(AUTOPILOT_WAIT_MAX_MS)
        .default(600_000),
    })
    .strict(),
]);
export type HostTestRequest = z.infer<typeof hostTestRequest>;
export type HostTestRunnerRequest = Exclude<HostTestRequest, { operation: 'wait' }>;
export const gestaltTestRunnerDynamicTool = {
  type: 'function',
  name: 'gestalt_test_runner',
  description:
    'Run workspace test suites as the host user; root supervisor only. Configure .gestalt/host-tests.json in the session workspace; suites reload without restart. list/inspect are read-only. start requires suite and UUID requestId; status/cancel/wait require runId. Prefer wait over polling: it returns a completed result or registers a run-specific Autopilot wait (maxWaitMs defaults to 600000). Yield only when accepted:true; otherwise continue in the same turn. No commands, environment or paths in arguments. Retains source fingerprints and private evidence; counts can be unknown. Keep the writer idle during tests. Never enables Autopilot or approves milestones.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['list', 'inspect', 'start', 'status', 'cancel', 'wait'] },
      suite: { type: 'string' },
      requestId: { type: 'string' },
      runId: { type: 'string' },
      maxWaitMs: {
        type: 'integer',
        minimum: AUTOPILOT_WAIT_MIN_MS,
        maximum: AUTOPILOT_WAIT_MAX_MS,
      },
    },
    required: ['operation'],
  },
} as const;

export type HostTestResult = {
  version: 1;
  runId: string;
  requestId: string;
  sessionId: string;
  suite: string;
  candidate: string;
  finalCandidate: string | null;
  state:
    | 'running'
    | 'passed'
    | 'failed'
    | 'cancelled'
    | 'timedOut'
    | 'outputLimit'
    | 'invalidated'
    | 'interrupted';
  startedAt: string;
  processExitedAt: string | null;
  observedAt: string;
  /** Persisted only after a terminal result has been returned to its owner. */
  resultReadAt?: string;
  exitCode: number | null;
  signal: string | null;
  counts: { passed: number; failed: number; skipped: number; total: number } | null;
  outputBytes: number;
  outputSha256: string | null;
  logPath: string;
  resultPath: string;
};
