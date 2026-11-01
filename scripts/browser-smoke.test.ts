/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import captured from './fixtures/browser-smoke-report.json';
import { validateSmokeReport } from './browser-smoke-contract.mjs';
import { runBrowserSmoke } from './run-browser-smoke.mjs';

const fixture = () => structuredClone(captured);
const workflow = () => parseDocument(readFileSync('.github/workflows/ci.yml', 'utf8'));

describe('required browser smoke reports', () => {
  it('accepts the captured thirteen distinct first-attempt passes', () => {
    expect(validateSmokeReport(fixture(), true).tests).toBe(13);
  });

  it.each([
    'zero',
    'missing',
    'extra',
    'duplicate',
    'tag',
    'skip',
    'failed',
    'retry',
    'global-error',
    'counts',
  ])('rejects a %s report despite a successful runner exit', (mutation) => {
    const report = fixture();
    const specs = report.suites[0].specs;
    if (mutation === 'zero') report.suites = [];
    if (mutation === 'missing') specs.pop();
    if (mutation === 'extra')
      specs.push({ ...structuredClone(specs[0]), title: 'unreviewed extra case' });
    if (mutation === 'duplicate') specs.push(structuredClone(specs[0]));
    if (mutation === 'tag') specs[0].tags = [];
    if (mutation === 'skip') specs[0].tests[0].expectedStatus = 'skipped';
    if (mutation === 'failed') specs[0].tests[0].results[0].status = 'failed';
    if (mutation === 'retry') specs[0].tests[0].results[0].retry = 1;
    if (mutation === 'global-error')
      (report.errors as unknown[]).push({ message: 'worker crashed' });
    if (mutation === 'counts') report.stats.expected = 0;
    expect(() => validateSmokeReport(report, true)).toThrow();
  });
});

describe('smoke command orchestration', () => {
  function harness(statuses = [0, 0], discovery = fixture(), execution = fixture()) {
    const run = vi
      .fn()
      .mockImplementationOnce(() => ({ status: statuses[0], stdout: JSON.stringify(discovery) }))
      .mockImplementationOnce(() => ({ status: statuses[1] }));
    const readReport = vi.fn(() => execution);
    const prepareReport = vi.fn();
    const env = {
      PLAYWRIGHT_JSON_OUTPUT_NAME: '/owned/report.json',
      PLAYWRIGHT_JSON_OUTPUT_FILE: '/stale/report.json',
    };
    return { run, readReport, prepareReport, env };
  }

  it('fixes selection, isolates discovery output, removes stale report and validates execution', () => {
    const h = harness();
    expect(runBrowserSmoke(h)).toBe(0);
    expect(h.run.mock.calls[0][0]).toEqual([
      'test',
      '--config',
      'playwright.smoke.config.ts',
      '--list',
      '--reporter=json',
    ]);
    expect(h.run.mock.calls[0][1].env).not.toHaveProperty('PLAYWRIGHT_JSON_OUTPUT_NAME');
    expect(h.run.mock.calls[0][1].env).not.toHaveProperty('PLAYWRIGHT_JSON_OUTPUT_FILE');
    expect(h.prepareReport).toHaveBeenCalledWith('/owned/report.json');
    expect(h.run.mock.calls[1][0]).toEqual([
      'test',
      '--config',
      'playwright.smoke.config.ts',
      '--reporter=list,json',
    ]);
    expect(h.readReport).toHaveBeenCalledWith('/owned/report.json');
    expect(h.prepareReport.mock.invocationCallOrder[0]).toBeLessThan(
      h.run.mock.invocationCallOrder[1],
    );
  });

  it.each([7, null])(
    'propagates a failed/interrupted execution (%s) without accepting an old passing report',
    (status) => {
      const h = harness([0, status] as number[]);
      expect(runBrowserSmoke(h)).toBe(status ?? 1);
      expect(h.readReport).not.toHaveBeenCalled();
    },
  );

  it('stops before execution for failed discovery', () => {
    const h = harness([9, 0]);
    expect(runBrowserSmoke(h)).toBe(9);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.prepareReport).not.toHaveBeenCalled();
  });

  it('stops before execution for zero discovery even when the runner exits zero', () => {
    const report = fixture();
    report.suites = [];
    const h = harness([0, 0], report);
    expect(() => runBrowserSmoke(h)).toThrow('inventory mismatch');
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('rejects a silently skipped execution after valid discovery', () => {
    const report = fixture();
    report.suites[0].specs[0].tests[0].results = [];
    expect(() => runBrowserSmoke(harness([0, 0], fixture(), report))).toThrow('first attempt');
  });

  it('enumerates the validated inventory without executing when requested', () => {
    const h = harness();
    expect(runBrowserSmoke({ ...h, listOnly: true })).toBe(0);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('exits nonzero through the actual CLI when a caller attempts to narrow selection', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-browser-smoke.mjs', '--grep=missing'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
    expect(result.stdout).not.toContain('smokePassed');
  });
});

describe('browser smoke workflow contract', () => {
  it('parses valid YAML and schedules an unconditional smoke gate for PR and main push', () => {
    const doc = workflow();
    expect(doc.errors).toEqual([]);
    const ci = doc.toJS();
    expect(JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:e2e:smoke']).toBe(
      'node scripts/run-browser-smoke.mjs',
    );
    expect(ci.on).toHaveProperty('pull_request');
    expect(ci.on.push.branches).toContain('main');
    expect(ci.permissions).toEqual({ contents: 'read' });
    const smoke = ci.jobs['browser-smoke'];
    expect(smoke.name).toBe('Browser smoke');
    expect(smoke.if).toBeUndefined();
    expect(smoke['continue-on-error']).toBeUndefined();
    expect(smoke.permissions).toBeUndefined();
    for (const step of smoke.steps) {
      expect(step['continue-on-error']).toBeUndefined();
      if (step.run) expect(step.if).toBeUndefined();
      if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
    const commands = smoke.steps.map((step: { run?: string }) => step.run);
    expect(commands).toEqual(
      expect.arrayContaining([
        'npm ci',
        'npm run build:client',
        'npx playwright install --with-deps chromium',
        'npm run test:lanes',
        'npm run test:e2e:smoke',
      ]),
    );
    expect(
      smoke.steps.find((step: { uses?: string }) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      ).if,
    ).toBe('always()');
    expect(ci.jobs.release.needs).toContain('browser-smoke');
    for (const id of [
      'browser-functional',
      'browser-evidence',
      'real-auth',
      'authorization-stress',
    ])
      expect(ci.jobs[id].if).toBe(
        "github.event_name == 'workflow_dispatch' && inputs.run_slow_tests",
      );
    expect(ci.jobs['browser-functional'].strategy.matrix.include).toHaveLength(4);
  });
});
