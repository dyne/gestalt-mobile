/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ChatCommand = {
  name: string;
  description: string;
  argumentPicker?: 'models' | 'reasoning' | 'impeccable';
};

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: 'model', description: 'Choose the model for the next turn', argumentPicker: 'models' },
  {
    name: 'reasoning',
    description: 'Choose reasoning effort for the next turn',
    argumentPicker: 'reasoning',
  },
];

export function commandQuery(message: string): string | null {
  const match = message.match(/^\/([^\s]*)$/);
  return match ? match[1].toLowerCase() : null;
}

const impeccableCommand: ChatCommand = {
  name: 'impeccable',
  description: 'Choose an Impeccable design action',
  argumentPicker: 'impeccable',
};

function commands(impeccable: boolean): readonly ChatCommand[] {
  return impeccable ? [...CHAT_COMMANDS, impeccableCommand] : CHAT_COMMANDS;
}

export function matchingCommands(message: string, impeccable = false): ChatCommand[] {
  const query = commandQuery(message);
  return query === null
    ? []
    : commands(impeccable).filter((command) => command.name.startsWith(query));
}

export function argumentPickerFor(
  message: string,
  impeccable = false,
): ChatCommand['argumentPicker'] | undefined {
  const commandName = message.match(/^\/([^\s]+)\s*$/)?.[1]?.toLowerCase();
  return commands(impeccable).find((command) => command.name === commandName)?.argumentPicker;
}

export function sortModelsNewestFirst(models: readonly string[]): string[] {
  return [...models].sort(
    (left, right) => compareModelVersion(right, left) || right.localeCompare(left),
  );
}

function compareModelVersion(left: string, right: string): number {
  const leftParts =
    left
      .match(/\d+(?:\.\d+)*/)?.[0]
      .split('.')
      .map(Number) ?? [];
  const rightParts =
    right
      .match(/\d+(?:\.\d+)*/)?.[0]
      .split('.')
      .map(Number) ?? [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
