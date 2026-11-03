/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { XerjIndexDiagnostic } from '../../../shared/contracts/xerj-status.js';

/** Read only error-bearing fields, never request bodies or arbitrary object values. */
function errorText(value: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (typeof value === 'string') {
    const text = value.slice(0, 16_384).trim();
    if (text.startsWith('{') || (text.startsWith('[') && !/^\[[\w-]+\]\s+/.test(text))) {
      try {
        return errorText(JSON.parse(text), depth + 1);
      } catch {
        return ''; // A partial structured payload is not safe display text.
      }
    }
    return text;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const error = value as Record<string, unknown>;
  for (const key of ['caused_by', 'error', 'reason', 'message']) {
    const text = errorText(error[key], depth + 1);
    if (text) return text;
  }
  return '';
}

/** Reduce an error to one cause before persisting or publishing any native prose. */
export function xerjErrorSummary(message: unknown): string | undefined {
  let text = errorText(message)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[redacted]');
  const lines = text.split(/[\r\n]+/).map((line) => line.trim());
  const causeIndex = lines.findLastIndex((line) => /^(?:\d+:\s*)?caused by:/i.test(line));
  text =
    causeIndex >= 0
      ? lines[causeIndex]!.replace(/^(?:\d+:\s*)?caused by:\s*/i, '') ||
        lines.slice(causeIndex + 1).find(Boolean) ||
        ''
      : (lines.find((line) => line && !/^at\s+\S+/.test(line)) ?? '');
  text = text
    .replace(/^watch:\s*pass \d+ FAILED after [\d.]+s:\s*/i, '')
    .replace(/^(?:(?:\d+:\s*)?(?:error|fatal|warning|caused by):\s*)+/i, '')
    .replace(/\b(?:still watching|waiting for (?:a |the )?(?:source |file )?change)[\s\S]*$/i, '')
    // Payloads can contain indexed text, prompts and model output. Drop the tail.
    .replace(
      /\b(?:request|response|headers|body|payload|document|source|prompt|model output|environment|preview of (?:field'?s? )?value)\s*[:=][\s\S]*$/i,
      '',
    )
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=][\s\S]*$/i, '')
    .replace(
      /\b(?:password|passwd|token|access[_-]?token|api[_ -]?key|secret|client[_-]?secret|credentials?)\s*[:=][\s\S]*$/gi,
      '[redacted]',
    )
    .replace(/\b(?:Bearer|Basic|ApiKey)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/\b[A-Z][A-Z0-9_]+\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/g, '[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[endpoint]')
    .replace(/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/g, '[redacted]')
    .replace(/(?:[A-Za-z]:[\\/]|~?\/)[^\s,:;)"']*(?::\d+(?::\d+)?)?/g, '[path]')
    .replace(/\b(file|path|directory)\s+[^\s:;,]+(?=:)/gi, '$1 [path]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s,;]+/g, '[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[endpoint]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AKIA[A-Z0-9]+)\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '[redacted]')
    .replace(/\b\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?\b/g, '')
    .replace(/\b(?:request|trace|correlation)[_-]?id\s*[:=]\s*[^\s,;]+/gi, '')
    .replace(
      /\b(?:after|in|elapsed|duration|took)\s*[:=]?\s*\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|minutes?)\b/gi,
      '',
    )
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|minutes?)\b/gi, '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '');
  if (!/[a-z]/i.test(text.replace(/\[(?:redacted|path|endpoint)\]/g, ''))) return undefined;
  return text.length <= 200 ? text : `${text.slice(0, 197).replace(/\s+\S*$/, '')}…`;
}

/** Classify bounded errors; retain only the reduced, redacted cause. */
export function xerjIndexDiagnostic(message: unknown): XerjIndexDiagnostic {
  const text = errorText(message);
  const summary = xerjErrorSummary(message);
  const pass = /^watch: pass (\d+) FAILED after (\d+(?:\.\d+)?)s:/.exec(text);
  const number = pass ? Number(pass[1]) : Number.NaN;
  const durationSeconds = pass ? Number(pass[2]) : Number.NaN;
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
    ...(summary ? { summary } : {}),
    ...(Number.isSafeInteger(number) && Number.isFinite(durationSeconds)
      ? { watchPass: { number, durationSeconds } }
      : {}),
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
