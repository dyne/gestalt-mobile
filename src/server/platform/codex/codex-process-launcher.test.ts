/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { afterEach, describe, expect, it } from 'vitest';

import { codexChildEnvironment, launchCodexAppServer } from './codex-process-launcher.js';
import { LIVE_CODEX_SHA256 } from '../live-design/native-contract.js';

const inheritedPlanStatus = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
const inheritedPlanStatusDirectory = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;

afterEach(() => {
  if (inheritedPlanStatus === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = inheritedPlanStatus;
  if (inheritedPlanStatusDirectory === undefined)
    delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = inheritedPlanStatusDirectory;
});

describe('codexChildEnvironment', () => {
  it('refuses an unpinned trusted executable before creating a process', () => {
    expect(() =>
      launchCodexAppServer(
        { profile: 'default', cwd: '/workspace' },
        {
          executable: '/unapproved/native',
          sha256: 'a'.repeat(64),
          environment: {},
        },
      ),
    ).toThrow('LIVE_RUNTIME_BINARY_UNVERIFIED');
    expect(() =>
      launchCodexAppServer(
        { profile: 'default', cwd: '/workspace' },
        {
          executable: '/absent/native',
          sha256: LIVE_CODEX_SHA256,
          environment: {},
        },
      ),
    ).toThrow('LIVE_RUNTIME_BINARY_UNVERIFIED');
  });
  it('does not pass an ambient plan status path to catalog or model discovery children', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = '/ambient/session';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_FILE');
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY');
  });

  it('merges only the explicit session runtime path while retaining other inherited values', () => {
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    const environment = codexChildEnvironment({
      GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY: '/private/session',
    });
    expect(environment.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY).toBe('/private/session');
    expect(environment.PATH).toBe(process.env.PATH);
  });
});
