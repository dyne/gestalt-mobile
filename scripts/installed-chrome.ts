/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { closeSync, constants, fstatSync, openSync, realpathSync, statSync } from 'node:fs';

// Keep descriptors alive for this runner's lifetime, including browser workers.
// The kernel closes them on exit. Never relocate session-owned temporary data.
const scratchDescriptors = new Map<string, number>();

function browserEnvironment(environment: NodeJS.ProcessEnv) {
  const directory = environment.TMPDIR || environment.TMP || environment.TEMP;
  // Leave room for Chromium's /com.google.Chrome.XXXXXX/SingletonSocket suffix
  // within Linux's 108-byte sockaddr_un.sun_path (including its terminating NUL).
  if (process.platform !== 'linux' || !directory || Buffer.byteLength(directory) <= 50)
    return undefined;

  const canonical = realpathSync(directory);
  let descriptor = scratchDescriptors.get(canonical);
  if (descriptor === undefined) {
    descriptor = openSync(
      canonical,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    scratchDescriptors.set(canonical, descriptor);
  }
  const alias = `/proc/${process.pid}/fd/${descriptor}`;
  const held = fstatSync(descriptor);
  const current = statSync(canonical);
  const target = statSync(alias);
  if (
    !held.isDirectory() ||
    held.uid !== process.getuid?.() ||
    held.dev !== current.dev ||
    held.ino !== current.ino ||
    target.dev !== held.dev ||
    target.ino !== held.ino ||
    Buffer.byteLength(alias) > 50
  ) {
    scratchDescriptors.delete(canonical);
    closeSync(descriptor);
    throw new Error('Cannot establish short browser temporary directory ownership');
  }
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { ...env, TMPDIR: alias, TMP: alias, TEMP: alias };
}

/** Use the operator's Chrome installation; never fall back to Playwright's browser cache. */
export function installedChrome(environment: NodeJS.ProcessEnv = process.env) {
  const env = browserEnvironment(environment);
  return {
    channel: 'chrome' as const,
    launchOptions: {
      ...(environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: environment.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
      ...(env ? { env } : {}),
    },
  };
}
