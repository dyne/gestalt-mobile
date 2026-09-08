/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { ProfileCatalog, ProfileOption } from '../../features/catalog/application/ports.js';

const launcherProfile: ProfileOption = {
  name: 'default',
  state: 'ok',
  status: 'Using the Gestalt launcher environment',
};

export class LauncherProfileCatalog implements ProfileCatalog {
  async list(): Promise<ProfileOption[]> {
    return [launcherProfile];
  }
  async require(name: string): Promise<ProfileOption> {
    const profile = (await this.list()).find((item) => item.name === name);
    if (!profile) throw new Error('PROFILE_NOT_FOUND');
    return profile;
  }
}
