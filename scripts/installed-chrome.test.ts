/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { installedChrome } from './installed-chrome.js';
import standard from '../playwright.config.js';
import functional from '../playwright.functional.config.js';
import auth from '../playwright.auth.config.js';
import evidence from '../playwright.evidence.config.js';
import smoke from '../playwright.smoke.config.js';
import verifiedSkills from '../playwright.verified-skills.config.js';

describe('installed Chrome selection', () => {
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
