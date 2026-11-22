/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ComponentVersion } from '../../../shared/contracts/component-version.js';
import { ManagedPlaywright } from './managed-playwright.js';

/** Read the installed version for Mobile's component list without launching Chrome. */
export async function readPlaywrightComponent(
  environment: NodeJS.ProcessEnv = process.env,
  adapter: Pick<ManagedPlaywright, 'check'> = new ManagedPlaywright(environment),
): Promise<ComponentVersion> {
  const component: ComponentVersion = {
    id: 'playwright',
    label: 'Playwright MCP',
    version: null,
    status: 'unavailable',
    detail: 'Managed Playwright is not installed or could not be validated.',
  };
  try {
    const installation = await adapter.check();
    if (installation.status !== 'installed') return component;
    return {
      ...component,
      version: installation.version,
      status: 'unverified',
      detail: 'Playwright is installed. Run gestalt update to check its prerequisites.',
    };
  } catch {
    return {
      ...component,
      status: 'unverified',
      detail: 'Playwright installation metadata could not be read.',
    };
  }
}
