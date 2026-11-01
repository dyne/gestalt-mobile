/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const paired = (file, title) =>
  ['mobile', 'desktop'].map((viewport) => ({ file, title: `${title} (${viewport})` }));

/** Change deliberately alongside the documented protection contracts. */
export const browserSmokeTests = [
  ...paired(
    'chat-resilience.spec.ts',
    'converges a live item through an overlapping snapshot, reconnect, and refresh',
  ),
  ...paired(
    'interactions.spec.ts',
    'retries a failed quiz once and suppresses a duplicate accepted request',
  ),
  ...paired(
    'autopilot-ui.spec.ts',
    'keyboard toggle is idempotent and preserves focus through a socket update',
  ),
  ...paired(
    'autopilot-ui.spec.ts',
    'keyboard attention action sends safe payload without disturbing focus',
  ),
  { file: 'autopilot-ui.spec.ts', title: '200 percent attention remains operable' },
  {
    file: 'chat-cache.spec.ts',
    title:
      'upgrades v2 storage and restores redacted chat on reload before authoritative reconciliation',
  },
  {
    file: 'file-browser.spec.ts',
    title: 'selecting a file opens the shared preview from Git and restores focus to that file',
  },
  {
    file: 'session-start.spec.ts',
    title: 'sends a selected named skill profile only when creating a new session',
  },
  {
    file: 'kimi-provider.spec.ts',
    title: 'restricts chat model switching to the session provider and badges kimi sessions',
  },
];

export const browserSmokeSpecs = [...new Set(browserSmokeTests.map(({ file }) => file))].sort();
const identity = ({ file, title }) => `${file} › ${title}`;

export function validateSmokeReport(report, executed = false) {
  if (!Array.isArray(report.suites) || !Array.isArray(report.errors) || report.errors.length)
    throw new Error('Smoke report is malformed or contains global errors');
  const specs = [];
  function visit(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  const expected = new Set(browserSmokeTests.map(identity));
  const found = specs.map(identity);
  const missing = [...expected].filter((test) => !found.includes(test));
  const extra = found.filter((test) => !expected.has(test));
  if (missing.length || extra.length || new Set(found).size !== found.length)
    throw new Error(
      `Smoke inventory mismatch: ${JSON.stringify({ missing, extra, count: found.length })}`,
    );
  for (const spec of specs) {
    if (!spec.tags?.includes('smoke') || spec.tests?.length !== 1)
      throw new Error(`Smoke tag/project mismatch: ${identity(spec)}`);
    const test = spec.tests[0];
    if (
      test.expectedStatus !== 'passed' ||
      test.annotations?.some(({ type }) => ['skip', 'fixme', 'fail'].includes(type))
    )
      throw new Error(`Smoke case must be enabled and passing: ${identity(spec)}`);
    if (
      executed &&
      (test.status !== 'expected' ||
        test.results?.length !== 1 ||
        test.results[0].status !== 'passed' ||
        test.results[0].retry !== 0 ||
        test.results[0].errors?.length)
    )
      throw new Error(`Smoke case did not pass on its first attempt: ${identity(spec)}`);
  }
  if (
    executed &&
    (report.stats?.expected !== expected.size ||
      report.stats.skipped !== 0 ||
      report.stats.unexpected !== 0 ||
      report.stats.flaky !== 0)
  )
    throw new Error('Smoke result counts do not match the required protection set');
  return { tests: specs.length, identities: found.sort() };
}
