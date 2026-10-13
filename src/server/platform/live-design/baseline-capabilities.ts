/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { isDeepStrictEqual } from 'node:util';

/** An empty actual baseline needs no unselected managed transport proposals.
 * This never removes a configured server or changes an existing thread override.
 * Any uncertain/nonempty surface follows the ordinary capability path and remains
 * subject to the complete production admission inventory.
 */
export function baselineHasNoManagedDelegates(input: {
  observed: unknown;
  threadConfig: Readonly<Record<string, unknown>>;
  skills: readonly { name: string }[];
}): boolean {
  if (input.skills.some(({ name }) => ['gestalt:xerj', 'gestalt:serena'].includes(name)))
    return false;
  if (Object.keys(input.threadConfig).some((key) => key.startsWith('mcp_servers.'))) return false;
  const response = input.observed as { config?: Record<string, unknown> } | null;
  if (!response?.config || typeof response.config !== 'object' || Array.isArray(response.config))
    return false;
  return (
    isDeepStrictEqual(response.config.mcp_servers, {}) &&
    (input.threadConfig.mcp_servers === undefined ||
      isDeepStrictEqual(input.threadConfig.mcp_servers, {}))
  );
}
