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
    expect(workflow).toContain('verify:');
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
    'npm run protocol:check',
    'npm run test:e2e',
    'npm run test:package',
  ])('runs %s', (command) => {
    expect(workflow).toContain(`run: ${command}`);
  });

  it('pins all actions to full commit SHAs with version comments', () => {
    const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s]+)(?:\s+#\s+(v\S+))?$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, action, version] of uses) {
      expect(action).toMatch(/^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      expect(version).toMatch(/^v\d/);
    }
  });

  it('keeps verification read-only and scopes publication credentials to npm publish', () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow.match(/NPM_TOKEN/g)).toHaveLength(1);
    expect(workflow.match(/NODE_AUTH_TOKEN/g)).toHaveLength(1);
    expect(workflow).toMatch(
      /Publish npm package[\s\S]*npm publish --access public --provenance[\s\S]*NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/,
    );
  });

  it('releases only verified canonical main with pinned semver and explicit tags', () => {
    expect(workflow).toContain('needs: [verify, package-smoke]');
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
});
