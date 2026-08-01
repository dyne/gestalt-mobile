/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ChatCommand = {
  name: string;
  description: string;
};

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: 'model', description: 'Choose the model for the next turn' },
  { name: 'reasoning', description: 'Choose reasoning effort for the next turn' },
];

export function commandQuery(message: string): string | null {
  const match = message.match(/^\/([^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

export function matchingCommands(message: string): ChatCommand[] {
  const query = commandQuery(message);
  return query === null ? [] : CHAT_COMMANDS.filter((command) => command.name.startsWith(query));
}
