/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ORG_PLAN_VALIDATION_TIMEOUT_MS,
  OrgPlanCommandValidator,
  type OrgPlanCommandExecute,
  type OrgPlanSkillDiscovery,
} from './org-plan-command-validator.js';

describe('OrgPlanCommandValidator', () => {
  it('discovers the installed skill once and invokes its validator without a shell', async () => {
    const discoverSkills = vi.fn(async () => [
      { name: 'gestalt:org-plan', path: '/skills/org-plan/SKILL.md' },
    ]);
    const execute = vi.fn(async () => undefined);
    const validator = new OrgPlanCommandValidator({ discoverSkills, execute });

    await expect(validator.validate('/workspace', '/workspace/plans/one.org')).resolves.toBe(true);
    await expect(validator.validate('/workspace', '/workspace/two.org')).resolves.toBe(true);

    expect(discoverSkills).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      '/skills/org-plan/scripts/org-plan',
      ['validate', '/workspace/plans/one.org'],
      { shell: false, timeout: ORG_PLAN_VALIDATION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
  });

  it('prefers an explicitly trusted helper and rejects command failures', async () => {
    const execute = vi
      .fn<OrgPlanCommandExecute>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('invalid'));
    const validator = new OrgPlanCommandValidator({
      helperPath: '/configured/org-plan',
      discoverSkills: vi.fn(async () => []),
      execute,
    });

    await expect(validator.validate('/workspace', '/workspace/valid.org')).resolves.toBe(true);
    await expect(validator.validate('/workspace', '/workspace/invalid.org')).resolves.toBe(false);
  });

  it('retries missing skill discovery and refuses relative helper paths', async () => {
    const discoverSkills = vi
      .fn<OrgPlanSkillDiscovery>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'gestalt:org-plan', path: '/skills/org-plan/SKILL.md' }]);
    const execute = vi.fn<OrgPlanCommandExecute>().mockResolvedValue(undefined);
    const validator = new OrgPlanCommandValidator({ discoverSkills, execute });

    await expect(validator.validate('/workspace', '/workspace/plan.org')).resolves.toBe(false);
    await expect(validator.validate('/workspace', '/workspace/plan.org')).resolves.toBe(true);
    expect(discoverSkills).toHaveBeenCalledTimes(2);
    await expect(
      new OrgPlanCommandValidator({ helperPath: 'relative/org-plan', execute }).validate(
        '/workspace',
        '/workspace/plan.org',
      ),
    ).resolves.toBe(false);
  });
});
