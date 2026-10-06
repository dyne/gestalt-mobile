/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
type Job = { if?: string; needs?: string[]; steps: { run?: string }[] };
const configuration = parse(workflow) as {
  on: Record<string, unknown>;
  concurrency: { group: string; 'cancel-in-progress': string };
  jobs: Record<string, Job>;
};
const packageSmoke = await readFile('scripts/smoke-packed-cli.mjs', 'utf8');

describe('GitHub verification workflow', () => {
  it('runs stable verification jobs for pull requests and main', () => {
    expect(configuration.on).toHaveProperty('pull_request');
    expect(configuration.on.push).toEqual({ branches: ['main'] });
    const required = configuration.jobs.release!.needs!;
    expect(required.toSorted()).toEqual(['package-smoke', 'quality', 'vitest']);
    expect(
      Object.entries(configuration.jobs)
        .filter(([, job]) => !job.if)
        .map(([id]) => id)
        .toSorted(),
    ).toEqual(required.toSorted());
    for (const id of required) {
      const job = configuration.jobs[id]!;
      expect(job.if).toBeUndefined();
      expect(job.steps.some((step) => /playwright|test:e2e/.test(step.run ?? ''))).toBe(false);
    }
    expect(configuration.jobs.vitest!.steps).toContainEqual({ name: 'Run tests', run: 'npm test' });
    expect(configuration.jobs['package-smoke']!.steps).toContainEqual({
      name: 'Test packed executable',
      run: 'npm run test:package',
    });
    expect(packageSmoke).toContain("run('npm', ['run', 'build'], root)");
    expect(workflow).toContain('node-version: 24');
  });

  it('retains expensive suites only on scheduled or manual runs outside the release gate', () => {
    expect(configuration.on).toHaveProperty('schedule');
    expect(configuration.on).toHaveProperty('workflow_dispatch');
    for (const id of [
      'browser-functional',
      'real-auth',
      'browser-evidence',
      'authorization-stress',
    ]) {
      expect(configuration.jobs[id]!.if).toBe(
        "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
      );
      expect(configuration.jobs.release!.needs).not.toContain(id);
    }
    const browserJobs = Object.entries(configuration.jobs).filter(([, job]) =>
      job.steps.some((step) => /playwright|test:e2e/.test(step.run ?? '')),
    );
    expect(browserJobs.map(([id]) => id).toSorted()).toEqual([
      'browser-evidence',
      'browser-functional',
      'real-auth',
    ]);
  });

  it('cancels obsolete PR work without interrupting main releases', () => {
    // Non-PR runs need unique groups: GitHub replaces pending runs even when
    // cancel-in-progress is false. Release has its own narrower publish lock.
    expect(configuration.concurrency.group).toBe(
      'ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.run_id }}',
    );
    expect(configuration.concurrency['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it.each([
    'npm ci',
    'npm run license:check',
    'npm run check',
    'npm test',
    'npm run lint',
    'npm run test:package',
  ])('runs %s', (command) => {
    expect(workflow).toContain(`run: ${command}`);
  });

  it('runs the audited functional browser lane', () => {
    expect(workflow).toContain(
      'npx playwright test --config playwright.functional.config.ts --shard=${{ matrix.shard }}',
    );
  });

  it('builds the relay-served client before running browser shards', () => {
    const browserJob = workflow.slice(
      workflow.indexOf('\n  browser-functional:'),
      workflow.indexOf('\n  real-auth:'),
    );
    expect(browserJob.indexOf('run: npm run build:client')).toBeGreaterThan(-1);
    expect(browserJob.indexOf('run: npm run build:client')).toBeLessThan(
      browserJob.indexOf('run: npx playwright test'),
    );
  });

  it('pins all actions to full commit SHAs with version comments', () => {
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)(?:\s+#\s+(v\S+))?$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, action, version] of uses) {
      expect(action).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      expect(version).toMatch(/^v\d/);
    }
  });

  it('keeps verification read-only and publishes through trusted OIDC identity', () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toMatch(/release:[\s\S]*permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).toMatch(
      /Publish npm package[\s\S]*npm install -g npm@latest[\s\S]*npm publish \. --tag latest/,
    );
  });

  it('releases only verified canonical main with pinned semver and explicit tags', () => {
    expect(configuration.jobs.release!.needs).toEqual(['quality', 'vitest', 'package-smoke']);
    expect(workflow).toContain("github.repository == 'dyne/gestalt-mobile'");
    expect(workflow).toContain(
      'ietf-tools/semver-action@c90370b2958652d71c06a3484129a4d423a6d8a8 # v1.11.0',
    );
    expect(workflow).toContain('noNewCommitBehavior: silent');
    expect(workflow).toContain('noVersionBumpBehavior: silent');
    expect(workflow).toContain('git push origin "refs/tags/v$VERSION"');
    expect(workflow).not.toContain('git push --tags');
    expect(workflow).toContain("require('./package.json').name");
    expect(workflow).toContain('node scripts/check-package-contents.mjs');
  });

  it('isolates each browser shard by port, output directory, and artifact name', () => {
    for (const port of [4173, 4174, 4175, 4176]) expect(workflow).toContain(`port: ${port}`);
    expect(workflow).toContain('--shard=${{ matrix.shard }}');
    expect(workflow).toContain('PLAYWRIGHT_OUTPUT_ID: ${{ matrix.output_id }}');
    expect(workflow).toContain('playwright-traces-${{ matrix.output_id }}');
  });
});
