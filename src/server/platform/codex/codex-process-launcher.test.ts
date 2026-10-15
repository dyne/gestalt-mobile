/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import {
  codexChildEnvironment,
  launchCodexAppServer,
  readLiveProcessEnvironment,
} from './codex-process-launcher.js';
import { LIVE_CODEX_SHA256 } from '../live-design/native-contract.js';

const inheritedCapabilities = process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
const inheritedPlanStatus = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
const inheritedPlanStatusDirectory = process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;

afterEach(() => {
  if (inheritedCapabilities === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES;
  else process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES = inheritedCapabilities;
  if (inheritedPlanStatus === undefined) delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = inheritedPlanStatus;
  if (inheritedPlanStatusDirectory === undefined)
    delete process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY;
  else process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = inheritedPlanStatusDirectory;
});

describe('codexChildEnvironment', () => {
  it('observes the actual exec environment and refuses an exited birth', async () => {
    const child = spawn(
      '/usr/bin/env',
      [
        '-i',
        'HOME=/actual-owning-home',
        'CODEX_HOME=/actual-owning-home',
        'TMPDIR=/actual-scratch',
        process.execPath,
        '-e',
        'process.stdout.write("ready");setInterval(()=>{},1000)',
      ],
      { env: { HOME: '/manager-wrapper-home' }, stdio: 'pipe' },
    );
    const closed = once(child, 'close');
    try {
      await once(child.stdout, 'data');
      expect(readLiveProcessEnvironment(child.pid!)).toEqual({
        home: '/actual-owning-home',
        codexHome: '/actual-owning-home',
        tmpdir: '/actual-scratch',
      });
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
    expect(() => readLiveProcessEnvironment(child.pid!)).toThrow(
      'LIVE_RUNTIME_ENVIRONMENT_UNVERIFIED',
    );
  });

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
    process.env.GESTALT_MOBILE_ORG_PLAN_CAPABILITIES = 'spoofed';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_CAPABILITIES');
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_FILE = '/ambient/session.json';
    process.env.GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY = '/ambient/session';
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_FILE');
    expect(codexChildEnvironment()).not.toHaveProperty('GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY');
  });

  it('scrubs capability assertions from fixed native launch environments too', () => {
    expect(
      codexChildEnvironment(undefined, {
        PATH: '/trusted',
        GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'untrusted',
      }),
    ).toEqual({ PATH: '/trusted' });
    expect(
      codexChildEnvironment(
        { GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'suspension-v1' },
        { PATH: '/trusted', GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'untrusted' },
      ),
    ).toEqual({ PATH: '/trusted', GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: 'suspension-v1' });
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
