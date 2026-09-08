/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { buildResumeCommand } from './resume-command.js';

describe('buildResumeCommand', () => {
  it('quotes every shell argument', () => {
    expect(
      buildResumeCommand({
        workspacePath: "/a b/it's",
        threadId: 't',
      }),
    ).toBe("'codex' 'resume' 't' '-C' '/a b/it'\"'\"'s' '--include-non-interactive'");
  });
});
