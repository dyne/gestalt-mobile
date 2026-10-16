/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Fixture contract tests; these do not claim actual Native model execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { safeBrowserFailure } from './live-production-edit-diagnostics.mjs';
import {
  createProductionEditProvider,
  liveEventFromRequest,
} from './live-production-edit-provider.mjs';

function body(event) {
  return {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Untrusted event:\n' + JSON.stringify(event) }],
      },
    ],
  };
}
const tool = (name, args) => ({ name, args });
test('browser diagnostics remove private grants, cookies and bearer canaries', () => {
  const bearer = 'bearer-canary-'.repeat(4);
  const diagnostic = safeBrowserFailure(
    `page.waitForURL: net::ERR_HTTP2_PROTOCOL_ERROR at https://preview.test/auth#grant=${bearer} cookie=${bearer}\nprivate stack`,
  );
  assert.ok(diagnostic.includes('net::ERR_HTTP2_PROTOCOL_ERROR'));
  assert.ok(!diagnostic.includes(bearer));
  assert.ok(!diagnostic.includes('preview.test'));
  assert.ok(!diagnostic.includes('private stack'));
});
const final = (_id, text) => JSON.parse(text);
function simulatePatch(root, call) {
  assert.equal(call.name, 'apply_patch');
  const lines = call.args.split('\n');
  const file = lines.find((line) => line.startsWith('*** Update File: ')).slice(17);
  assert.ok(file.startsWith(root + '/'));
  const removed = lines
    .filter((line) => line.startsWith('-'))
    .map((line) => line.slice(1))
    .join('\n');
  const added = lines
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1))
    .join('\n');
  const source = readFileSync(file, 'utf8');
  assert.equal(source.split(removed).length, 2);
  writeFileSync(file, source.replace(removed, added));
}
test('controlled Native patch plan interoperates with the actual pinned helper wrap, accept and discard', () => {
  const helper = process.env.LIVE_TEST_IMPECCABLE;
  assert.equal(
    createHash('sha256').update(readFileSync(helper)).digest('hex'),
    '81fe24a7430571de1003f34fecf787bdc0acefa1be80525ccea9d4b74b5441a0',
  );
  const root = mkdtempSync(join(tmpdir(), 'l11-edit-contract-'));
  try {
    mkdirSync(join(root, '.impeccable/live'), { recursive: true });
    writeFileSync(
      join(root, '.impeccable/live/config.json'),
      JSON.stringify({ files: ['index.html'], insertBefore: '</body>', commentSyntax: 'html' }),
    );
    writeFileSync(
      join(root, 'index.html'),
      '<html>\n<body>\n<h1 class="hero-title">Owning app</h1>\n<script src="/live.js?token=unrelated-bootstrap-canary"></script>\n</body>\n</html>\n',
    );
    const run = (args) =>
      JSON.parse(
        execFileSync(helper, [...args, '--target', root], {
          cwd: root,
          encoding: 'utf8',
          stdio: 'pipe',
        })
          .trim()
          .split('\n')
          .at(-1),
      );
    const provider = createProductionEditProvider(root, final, {});
    const generate = (id, text) => {
      const scaffold = run([
        'live-wrap',
        '--id',
        id,
        '--count',
        '2',
        '--classes',
        'hero-title',
        '--tag',
        'h1',
        '--text',
        text,
        '--defer-source-write',
      ]);
      const request = body({ type: 'generate', id, count: 2, scaffold });
      const patch = provider(request, tool);
      assert.ok(!patch.args.includes('unrelated-bootstrap-canary'));
      simulatePatch(root, patch);
      assert.equal(provider(request, tool).status, 'done');
    };
    generate('1234abcd', 'Owning app');
    const accepted = run(['live-accept', '--id', '1234abcd', '--variant', '1']);
    assert.equal(accepted.handled, true);
    const acceptedSource = readFileSync(join(root, 'index.html'), 'utf8');
    assert.ok(acceptedSource.includes('Production chosen variant'));
    assert.ok(!acceptedSource.includes('impeccable-variants-start'));
    writeFileSync(join(root, 'app.js'), "export const marker = 'original';\n");
    const steer = body({ type: 'steer', id: '1234abce', message: 'production steer' });
    simulatePatch(root, provider(steer, tool));
    assert.equal(provider(steer, tool).status, 'steer_done');
    const manual = body({
      type: 'manual_edit_apply',
      id: '1234abcf',
      batch: {
        entries: [
          {
            id: 'entry-1',
            ops: [
              { originalText: 'Production chosen variant', newText: 'Production manual approved' },
            ],
          },
        ],
      },
    });
    simulatePatch(root, provider(manual, tool));
    assert.deepEqual(provider(manual, tool).data.appliedEntryIds, ['entry-1']);
    const manualSource = readFileSync(join(root, 'index.html'), 'utf8');
    generate('1234abd0', 'Production manual approved');
    const discarded = run(['live-accept', '--id', '1234abd0', '--discard']);
    assert.equal(discarded.handled, true);
    assert.equal(readFileSync(join(root, 'index.html'), 'utf8'), manualSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('controlled provider rejects an authentication token in model request event content', () => {
  assert.throws(() =>
    liveEventFromRequest(
      body({ type: 'generate', id: '1234abcd', token: 'must-not-reach-provider' }),
    ),
  );
});
