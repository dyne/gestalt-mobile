/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { XerjIndexDiagnostic } from '../../../shared/contracts/xerj-status.js';

/** Classify bounded native prose; never retain it or copy arbitrary native fields. */
export function xerjIndexDiagnostic(message: unknown): XerjIndexDiagnostic {
  const text = typeof message === 'string' ? message.slice(0, 16_384) : '';
  const code = text.includes('refusing ambiguous assignment')
    ? 'ambiguous-assignment'
    : /\b(timeout|timed out)\b/i.test(text)
      ? 'timeout'
      : /\b(unauthorized|forbidden|authentication)\b/i.test(text)
        ? 'authentication'
        : /\b(connection refused|connection reset|unreachable)\b/i.test(text)
          ? 'connection'
          : /\b(out of memory|no space left|disk full)\b/i.test(text)
            ? 'capacity'
            : text.includes('rebuild with a new --state-dir and a new --prefix')
              ? 'rebuild-required'
              : /^watch: pass \d+ FAILED after [\d.]+s:/.test(text)
                ? 'watch-pass-failed'
                : text ===
                    'watch: the platform reported dropped events (watch queue overflow); re-hashing the whole tree for this pass'
                  ? 'watch-rescan'
                  : 'unknown-warning';
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    code,
    messageDigest: text ? createHash('sha256').update(text).digest('hex') : null,
  };
}

/** One private atomic record per root; repeated warnings cannot grow a log. */
export async function saveXerjIndexDiagnostic(
  directory: string,
  diagnostic: XerjIndexDiagnostic,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.gestalt-index-diagnostic.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(diagnostic)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, '.gestalt-index-diagnostic.json'));
  } finally {
    await rm(temporary, { force: true });
  }
}
