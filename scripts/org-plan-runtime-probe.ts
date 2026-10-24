/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Opt-in read-only capability probe. No model turn, installation or active-session restart.
import { mkdtemp, rm, symlink, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { launchCodexAppServer } from '../src/server/platform/codex/codex-process-launcher.js';
import { decodeCodexPolicyCatalog } from '../src/server/platform/codex/codex-model-catalog.js';

const isolatedHome = await mkdtemp(join(tmpdir(), 'org-policy-runtime-probe-'));
const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
try {
  await access(auth);
  await symlink(auth, join(isolatedHome, 'auth.json'));
} catch {
  /* Authentication may come from the environment; do not print credentials. */
}
const server = launchCodexAppServer({
  profile: '',
  cwd: isolatedHome,
  environment: { CODEX_HOME: isolatedHome },
});
server.child.stderr.resume();
const deadline = setTimeout(() => server.close(), 15_000);
try {
  await server.rpc.request('initialize', {
    clientInfo: { name: 'org-policy-probe', version: '1' },
    capabilities: null,
  });
  const catalog = decodeCodexPolicyCatalog(await server.rpc.request('model/list', {}));
  console.log(
    JSON.stringify({
      live: true,
      modelTurnStarted: false,
      catalogAvailable: catalog !== null,
      policyModels: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'].map((id) => ({
        id,
        reasoningEfforts:
          catalog?.models.find((model) => model.id === id)?.reasoningEfforts ?? null,
      })),
    }),
  );
} catch {
  console.log(
    JSON.stringify({
      live: true,
      modelTurnStarted: false,
      catalogAvailable: false,
      limitation: 'isolated Codex app-server initialize/model-list unavailable',
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  server.close();
  if (server.child.exitCode === null && server.child.signalCode === null)
    await new Promise<void>((resolve) => server.child.once('exit', () => resolve()));
  await rm(isolatedHome, { recursive: true, force: true });
}
