/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { productionEditBrowser } from './live-production-edit-browser-host.mjs';
import { removeOwnedProofTree } from './live-proof-cleanup.mjs';
const root = mkdtempSync(
  join(realpathSync(process.env.RUNNER_TEMP), 'l11-entry-browser-preflight-'),
);
const identity = lstatSync(root);
const evidence = resolve('test-results/live-caddy-proof/browser-preflight');
mkdirSync(evidence, { recursive: true });
const report = { genuineProvider: false, noNativeOrProvider: true };
try {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=browser-preflight.invalid',
    ],
    { stdio: 'ignore', timeout: 20000 },
  );
  await productionEditBrowser({
    privateRoot: root,
    certificate: join(root, 'cert.pem'),
    report,
    browser: { preflight: true, resultFile: join(evidence, 'browser.json') },
  });
  report.passed = true;
} finally {
  if (report.editBrowserRemainingProcesses === 0)
    removeOwnedProofTree(root, identity, { processesClosed: true });
  else report.cleanupPending = true;
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
