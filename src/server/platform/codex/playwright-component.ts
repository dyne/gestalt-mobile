/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ComponentVersion } from '../../../shared/contracts/component-version.js';
import { ManagedPlaywright } from './managed-playwright.js';

/** Uses a disposable local page to test Chrome without acquiring a session lease. */
export async function probePlaywrightComponent(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  adapter = new ManagedPlaywright(environment),
): Promise<ComponentVersion> {
  let component: ComponentVersion = {
    id: 'playwright',
    label: 'Playwright MCP',
    version: null,
    status: 'unavailable',
    detail: 'Managed Playwright is not installed or could not be validated.',
  };
  try {
    const installation = await adapter.check();
    if (installation.status !== 'installed') return component;
    component = { ...component, version: installation.version };
    let readiness = await adapter.ready(installation.manager, cwd, Date.now() + 15000, [
      '--launch',
    ]);
    // Older managers reject --launch. Preserve prerequisite reporting during
    // separate Mobile/manager upgrades, without claiming a browser was tested.
    if (readiness.package === 'unknown' && readiness.chrome === 'unknown') {
      readiness = await adapter.ready(installation.manager, cwd, Date.now() + 5000);
    }
    const engine = readiness.playwrightVersion ? `Playwright ${readiness.playwrightVersion}; ` : '';
    return {
      ...component,
      version: installation.version,
      status: readiness.ready
        ? readiness.browserTest === 'passed'
          ? 'working'
          : 'ready'
        : 'unavailable',
      detail: readiness.ready
        ? readiness.browserTest === 'passed'
          ? `${engine}Chrome ${readiness.chromeVersion ?? 'detected'}; browser page check passed at startup.`
          : `${engine}Chrome ${readiness.chromeVersion ?? 'detected'}; prerequisites ready. Browser session has not been tested.`
        : 'Playwright is installed; Chrome or runtime prerequisites are unavailable or unverified.',
    };
  } catch {
    return {
      ...component,
      status: 'unverified',
      detail: 'Playwright readiness could not be checked.',
    };
  }
}
