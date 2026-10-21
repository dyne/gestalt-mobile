/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  checkpointPlanMeasurement,
  PLAN_MEASUREMENT_COMMAND_TIMEOUT_MS,
} from './plan-measurement-command.js';

describe('plan measurement command adapter', () => {
  it('uses a bounded shell-free helper invocation', () => {
    expect(PLAN_MEASUREMENT_COMMAND_TIMEOUT_MS).toBe(15_000);
  });

  it('supplies the compiled host capability to a shell-free measurement helper', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'org helper '));
    const helper = join(directory, 'capture.mjs');
    const output = join(directory, 'captured.json');
    try {
      await writeFile(
        helper,
        `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({ args: process.argv.slice(2), capability: process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES }));\n`,
        { mode: 0o700 },
      );
      vi.stubEnv('GESTALT_MOBILE_ORG_PLAN_CAPABILITIES', 'untrusted-ambient');
      const snapshot = {
        capturedAt: '2026-10-13T12:00:00Z',
        weeklyRemainingPercent: null,
        threadTokens: null,
      };
      await checkpointPlanMeasurement(helper, '/work/plan with spaces.org', 'child', snapshot);
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({
        args: [
          'measure',
          'checkpoint',
          '/work/plan with spaces.org',
          'child',
          JSON.stringify(snapshot),
        ],
        capability: 'suspension-v1,nested-suspension-v1,l1-model-policy-v1',
      });
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
