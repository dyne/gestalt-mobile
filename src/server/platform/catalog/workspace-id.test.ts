/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { workspaceId } from './workspace-id.js';
describe('workspaceId', () => {
  it('does not expose workspace paths in IDs', () =>
    expect(workspaceId('/private/project')).not.toContain('private'));
});
