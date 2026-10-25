/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Isolated live source-port check: creates one root, reads model/list, starts no model turn/child.
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { CodexSessionRuntime } from '../src/server/platform/codex/session-runtime.js';
import {
  launchCodexAppServer,
  type CodexProcess,
} from '../src/server/platform/codex/codex-process-launcher.js';
import { RelaySession } from '../src/server/features/sessions/model/relay-session.js';
import { parseSupervisedPlan } from '../src/server/features/plans/application/parse-supervised-plan.js';
import { ExecutorLaunchValidationReader } from '../src/server/features/plans/application/executor-launch-validation.js';
import { ExecutorModelEvidenceReader } from '../src/server/features/plans/application/executor-model-evidence.js';

const directory = await mkdtemp(join(tmpdir(), 'org-prelaunch-probe-'));
const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
try {
  await access(auth);
  await symlink(auth, join(directory, 'auth.json'));
} catch {
  /* Environment auth may be used. */
}
const processes: CodexProcess[] = [];
let turns = 0;
let rootStarts = 0;
const runtime = new CodexSessionRuntime((input) => {
  const server = launchCodexAppServer({
    ...input,
    environment: { ...input.environment, CODEX_HOME: directory },
  });
  processes.push(server);
  server.child.stderr.resume();
  const request = server.rpc.request.bind(server.rpc);
  server.rpc.request = async (method, params) => {
    if (method === 'turn/start') turns++;
    if (method === 'thread/start') rootStarts++;
    return request(method, params);
  };
  return server;
});
const deadline = setTimeout(() => runtime.stopAll(), 20_000);
try {
  const parsed = parseSupervisedPlan({
    workspacePath: directory,
    planPath: join(directory, 'probe.org'),
    source: `#+TITLE: Prelaunch source probe
#+MODEL_POLICY_VERSION: 1
* TODO [#A] Validate requested launch
:PROPERTIES:
:ID: probe
:SKILLS: $bash-linux
:REVIEW_STATUS: UNREVIEWED
:MODEL: gpt-6.1-sol
:REASONING_EFFORT: medium
:MODEL_RATIONALE: Isolated catalog probe only.
:MODEL_FALLBACKS: none
:MODEL_ESCALATION_TRIGGER: Catalog does not support the requested settings.
:END:
- Effort :: Small
- Goal :: Read catalog before creating an executor.
- Notes :: No execution or plan mutation is authorized by this probe.
`,
  });
  if (parsed.kind !== 'available') throw new Error('Invalid probe plan');
  const session = await runtime.start(
    RelaySession.create({
      id: 'isolated-prelaunch',
      provider: 'codex',
      workspaceId: 'probe',
      workspacePath: directory,
      profile: 'default',
      model: 'gpt-6.1-sol',
      effectiveSkillSelection: { skills: [] },
      executionPolicy: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      now: new Date().toISOString(),
    }).snapshot,
    new Date().toISOString(),
  );
  const context = () => ({
    sessionId: session.id,
    provider: 'codex' as const,
    rootThreadId: session.threadId ?? null,
    planIdentity: 'isolated-fixture',
    modelPolicyStatus: 'required' as const,
    plan: parsed.plan,
    executor: null,
  });
  const executorLaunch = await new ExecutorLaunchValidationReader(context, {
    read: (input) => runtime.readExecutorPolicyCatalog(input),
  }).read(session.id);
  const modelPolicy = await new ExecutorModelEvidenceReader(context, {
    read: (input) => runtime.readExecutorConfiguration(input),
  }).read(session.id);
  const passed =
    executorLaunch?.validated === true &&
    modelPolicy?.code === 'CHILD_NOT_LAUNCHED' &&
    modelPolicy.effective.model === null &&
    modelPolicy.catalogRevision === null &&
    turns === 0 &&
    rootStarts === 1;
  console.log(
    JSON.stringify({
      scope: 'live-source-port-with-isolated-controller-fixture',
      passed,
      modelTurns: turns,
      rootStarts,
      executorLaunch,
      childEvidence: {
        code: modelPolicy?.code,
        effective: modelPolicy?.effective,
        catalogRevision: modelPolicy?.catalogRevision,
      },
      installedUpdateVerified: false,
      executorExecutionVerified: false,
    }),
  );
  if (!passed) process.exitCode = 1;
} catch {
  console.log(
    JSON.stringify({
      passed: false,
      scope: 'live-source-port-with-isolated-controller-fixture',
      limitation: 'Root initialization or prelaunch catalog read unavailable',
      modelTurns: turns,
      rootStarts,
      installedUpdateVerified: false,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  runtime.stopAll();
  await Promise.all(
    processes.map(async ({ child }) => {
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }),
  );
  await rm(directory, { recursive: true, force: true });
}
