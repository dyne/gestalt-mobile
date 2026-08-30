/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  GESTALT_ORG_PLAN_CHECKPOINT_TOOL_NAME,
  gestaltOrgPlanCheckpointDynamicTool,
  parseOrgPlanCheckpoint,
} from './org-plan-checkpoint.js';

const accepted = {
  version: 1,
  kind: 'l1Accepted',
  planIdentity: 'a'.repeat(32),
  l1Id: 'add-supervision-checkpoint-semantics',
  position: 'L2',
  verdict: 'ACCEPT',
  commit: { kind: 'created', subject: 'feat(relay): checkpoint reports', shortHash: '1234abcd' },
  findings: 'No P1 findings.',
  tests: 'npm test passed.',
};

describe('Org Plan checkpoint contract', () => {
  it('exposes a closed schema-v1 dynamic tool', () => {
    expect(gestaltOrgPlanCheckpointDynamicTool).toMatchObject({
      name: GESTALT_ORG_PLAN_CHECKPOINT_TOOL_NAME,
      inputSchema: { additionalProperties: false },
    });
    expect(parseOrgPlanCheckpoint(accepted)).toEqual(accepted);
  });

  it('keeps L1 and terminal variants disjoint and bounded', () => {
    expect(parseOrgPlanCheckpoint({ ...accepted, position: 'L2.1' })).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...accepted, verdict: 'REJECT' })).toBeNull();
    expect(
      parseOrgPlanCheckpoint({
        ...accepted,
        commit: { kind: 'created', subject: 'x', shortHash: 'not-a-hash' },
      }),
    ).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...accepted, extra: true })).toBeNull();
    expect(
      parseOrgPlanCheckpoint({
        version: 1,
        kind: 'terminalReviewAccepted',
        planIdentity: accepted.planIdentity,
        verdict: 'ACCEPT',
      }),
    ).toMatchObject({ kind: 'terminalReviewAccepted' });
    expect(parseOrgPlanCheckpoint({ ...accepted, kind: 'terminalReviewAccepted' })).toBeNull();
  });
});
