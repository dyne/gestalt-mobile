/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedChrome } from './installed-chrome.js';
import standard from '../playwright.config.js';
import functional from '../playwright.functional.config.js';
import auth from '../playwright.auth.config.js';
import evidence from '../playwright.evidence.config.js';
import smoke from '../playwright.smoke.config.js';
import verifiedSkills from '../playwright.verified-skills.config.js';

describe('installed Chrome selection', () => {
  it.skipIf(process.platform !== 'linux')(
    'keeps long browser scratch in the same owned directory with a bounded socket path',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'chrome-scratch-'));
      try {
        const directory = join(
          root,
          'workspace with spaces',
          'tmp',
          'sessions',
          'mobile-' + 'a'.repeat(64),
        );
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const environment = {
          TMPDIR: directory,
          TMP: '/hostile',
          TEMP: '/hostile',
          GESTALT_SESSION_TMP_CONTEXT: JSON.stringify({ directory }),
          PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/installed/Chrome Stable',
        };
        const before = { ...environment };
        expect(
          Buffer.byteLength(directory + '/com.google.Chrome.XXXXXX/SingletonSocket'),
        ).toBeGreaterThan(107);
        const options = installedChrome(environment).launchOptions;
        const env = options.env!;
        expect(options.executablePath).toBe(environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH);
        expect(
          Buffer.byteLength(env.TMPDIR + '/com.google.Chrome.XXXXXX/SingletonSocket'),
        ).toBeLessThan(108);
        expect(realpathSync(env.TMPDIR)).toBe(realpathSync(directory));
        expect(statSync(env.TMPDIR).ino).toBe(statSync(directory).ino);
        expect(env.TMP).toBe(env.TMPDIR);
        expect(env.TEMP).toBe(env.TMPDIR);
        expect(env.GESTALT_SESSION_TMP_CONTEXT).toBe(environment.GESTALT_SESSION_TMP_CONTEXT);
        writeFileSync(join(env.TMPDIR, 'owned-proof'), 'proof');
        expect(statSync(join(directory, 'owned-proof')).isFile()).toBe(true);
        expect(installedChrome(environment).launchOptions.env?.TMPDIR).toBe(env.TMPDIR);
        expect(environment).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps short temporary paths unchanged', () => {
    expect(installedChrome({ TMPDIR: '/tmp' }).launchOptions).toEqual({});
  });

  it('uses the system Chrome channel even when a Playwright browser cache is configured', () => {
    expect(installedChrome({ PLAYWRIGHT_BROWSERS_PATH: '/bundled/browsers' })).toEqual({
      channel: 'chrome',
      launchOptions: {},
    });
  });

  it('uses the explicitly configured installed executable, including paths with spaces', () => {
    expect(
      installedChrome({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/installed/Chrome Stable' }),
    ).toEqual({
      channel: 'chrome',
      launchOptions: { executablePath: '/installed/Chrome Stable' },
    });
  });

  it.each(Object.entries({ standard, functional, auth, evidence, smoke, verifiedSkills }))(
    '%s browser configuration selects installed Chrome',
    (_name, config) => {
      expect(config.use?.channel).toBe('chrome');
      expect(config.use?.launchOptions).toEqual(installedChrome().launchOptions);
    },
  );
});
