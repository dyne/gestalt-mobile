/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { isLocalOrgHref, workspacePlanNameFromHref } from './org-plan-link.js';

describe('local Org plan links', () => {
  it('maps absolute links and source locations below the selected workspace', () => {
    expect(workspacePlanNameFromHref('/projects/one/plans/roadmap.org', '/projects/one')).toBe(
      'plans/roadmap.org',
    );
    expect(workspacePlanNameFromHref('/projects/one/roadmap.org:42:7', '/projects/one/')).toBe(
      'roadmap.org',
    );
    expect(
      workspacePlanNameFromHref('/projects/one/plans/my%20roadmap.org#L12C3', '/projects/one'),
    ).toBe('plans/my roadmap.org');
  });

  it('rejects external URLs, non-Org files, and files outside the workspace', () => {
    expect(isLocalOrgHref('/projects/one/roadmap.org:12')).toBe(true);
    expect(isLocalOrgHref('https://example.com/roadmap.org')).toBe(false);
    expect(workspacePlanNameFromHref('/projects/two/roadmap.org', '/projects/one')).toBeNull();
    expect(workspacePlanNameFromHref('/projects/one/notes.md', '/projects/one')).toBeNull();
    expect(
      workspacePlanNameFromHref('/projects/one/../two/roadmap.org', '/projects/one'),
    ).toBeNull();
  });
});
