/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

describe('GitHub verification workflow', () => {
  it('runs stable verification jobs for pull requests and main', () => {
    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('quality:');
    expect(workflow).toContain('vitest:');
    expect(workflow).toContain('build:');
    expect(workflow).toContain('browser-functional:');
    expect(workflow).toContain('package-smoke:');
    expect(workflow).toContain('node-version: 24');
  });

  it.each([
    'npm ci',
    'npm run license:check',
    'npm run check',
    'npm test',
    'npm run lint',
    'npm run build',
    'npm run test:package',
  ])('runs %s', (command) => {
    expect(workflow).toContain(`run: ${command}`);
  });

  it('runs the audited functional browser lane', () => {
    expect(workflow).toContain(
      'npx playwright test --config playwright.functional.config.ts --shard=${{ matrix.shard }}',
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
    expect(workflow).toContain(
      'needs: [quality, vitest, build, browser-functional, package-smoke, real-auth]',
    );
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
