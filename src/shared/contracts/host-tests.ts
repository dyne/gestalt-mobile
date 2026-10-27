/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { z } from 'zod';

const suite = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const runId = z.string().uuid();
export const hostTestRequest = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('inspect'), suite }).strict(),
  z
    .object({
      operation: z.literal('start'),
      suite,
      candidate: z.string().regex(/^[a-f0-9]{64}$/),
      requestId: runId,
    })
    .strict(),
  z.object({ operation: z.literal('status'), runId }).strict(),
  z.object({ operation: z.literal('cancel'), runId }).strict(),
]);
export type HostTestRequest = z.infer<typeof hostTestRequest>;
export const gestaltTestRunnerDynamicTool = {
  type: 'function',
  name: 'gestalt_test_runner',
  description:
    'Run host-configured test suites outside the agent shell sandbox. Root supervisor only. Disabled unless the operator configures a suite and approves its exact Git-visible candidate digest. list/inspect do not execute code. start uses an idempotent requestId; status/cancel require the returned runId. Never accepts commands, environment, or paths. Results include UTC observations and private evidence paths; counts can be unknown. Does not approve milestones or resume Autopilot.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', enum: ['list', 'inspect', 'start', 'status', 'cancel'] },
      suite: { type: 'string' },
      candidate: { type: 'string' },
      requestId: { type: 'string' },
      runId: { type: 'string' },
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
  exitCode: number | null;
  signal: string | null;
  counts: { passed: number; failed: number; skipped: number; total: number } | null;
  outputBytes: number;
  outputSha256: string | null;
  logPath: string;
  resultPath: string;
};
