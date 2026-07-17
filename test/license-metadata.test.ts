/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const copyright = 'Copyright (C) 2026 Dyne.org foundation';
const designCredit = 'Designed by Denis Roio <jaromil@dyne.org>';
const spdx = 'SPDX-License-Identifier: AGPL-3.0-or-later';

describe('project license metadata', () => {
  it('ships the canonical GNU Affero General Public License version 3', async () => {
    const license = await readFile('LICENSE', 'utf8');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(license).toContain('Version 3, 19 November 2007');
    expect(license).toContain('Copyright (C) 2007 Free Software Foundation, Inc.');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
  });

  it('states exact attribution and SPDX metadata in the README and package manifest', async () => {
    const readme = await readFile('README.md', 'utf8');
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { license?: string };
    expect(readme).toContain(`${copyright}\n${designCredit}`);
    expect(readme).toContain(spdx);
    expect(manifest.license).toBe('AGPL-3.0-or-later');
  });
});
