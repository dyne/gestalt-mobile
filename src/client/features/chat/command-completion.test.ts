/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { argumentPickerFor, CHAT_COMMANDS, commandQuery, matchingCommands, sortModelsNewestFirst } from './command-completion.js';

describe('command completion', () => {
  it('lists all registered commands after a slash and narrows them as the name is typed', () => {
    expect(matchingCommands('/').map((command) => command.name)).toEqual(['model', 'reasoning']);
    expect(matchingCommands('/mo').map((command) => command.name)).toEqual(['model']);
    expect(matchingCommands('/x')).toEqual([]);
  });

  it('stops completing after command arguments begin', () => {
    expect(commandQuery('/model ')).toBeNull();
    expect(matchingCommands('/model gpt-5.6-terra')).toEqual([]);
  });

  it('keeps every registered argument picker active after command completion adds a space', () => {
    for (const command of CHAT_COMMANDS) {
      if (command.argumentPicker) {
        expect(argumentPickerFor(`/${command.name} `)).toBe(command.argumentPicker);
      }
    }
  });

  it('sorts higher model versions before lower versions', () => {
    expect(sortModelsNewestFirst(['gpt-5.4', 'gpt-5.6-terra', 'gpt-5.5'])).toEqual([
      'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4',
    ]);
  });
});
