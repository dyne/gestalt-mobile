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

  it('grants read-only contents and never references publication credentials', () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  });
});
