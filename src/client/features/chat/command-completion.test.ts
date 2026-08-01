/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { commandQuery, matchingCommands } from './command-completion.js';

describe('command completion', () => {
  it('lists all registered commands after a slash and narrows them as the name is typed', () => {
    expect(matchingCommands('/').map((command) => command.name)).toEqual(['model']);
    expect(matchingCommands('/mo').map((command) => command.name)).toEqual(['model']);
    expect(matchingCommands('/x')).toEqual([]);
  });

  it('stops completing after command arguments begin', () => {
    expect(commandQuery('/model ')).toBeNull();
    expect(matchingCommands('/model gpt-5.6-terra')).toEqual([]);
  });
});
