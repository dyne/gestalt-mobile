/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it } from 'vitest';

import { codexChildEnvironment } from './codex-process-launcher.js';

const inheritedPlanStatus = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;

afterEach(() => {
  if (inheritedPlanStatus === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = inheritedPlanStatus;
});

describe('codexChildEnvironment', () => {
  it('does not pass an ambient plan status path to catalog or model discovery children', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_FILE');
  });

  it('merges only the explicit session runtime path while retaining other inherited values', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    const environment = codexChildEnvironment({
      GESTALT_MOBILE_ORG_PLAN_STATUS_FILE: '/private/session.json',
    });
    expect(environment.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE).toBe('/private/session.json');
    expect(environment.PATH).toBe(process.env.PATH);
  });
});
