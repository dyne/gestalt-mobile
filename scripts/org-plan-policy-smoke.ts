/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Opt-in live source smoke. Uses real model turns in an isolated workspace/home.
// Never attaches an existing session or the user's implementation plan.
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { composeRelayApp } from '../src/server/composition.js';
import { launchCodexAppServer } from '../src/server/platform/codex/codex-process-launcher.js';
import {
  planStatusDirectoryPath,
  planStatusFilePath,
} from '../src/server/platform/plans/filesystem-plan-status-source.js';

if (!process.argv.includes('--execute'))
  throw new Error('Explicit --execute required: this smoke consumes model quota.');
const agentsFlag = process.argv.indexOf('--agents');
if (agentsFlag < 0 || !process.argv[agentsFlag + 1])
  throw new Error('--agents SOURCE_CHECKOUT is required.');
const agents = resolve(process.argv[agentsFlag + 1]!);
const skill = join(agents, 'plugins/gestalt/skills/org-plan');
await access(join(skill, 'scripts/org-plan'));
const temporary = await mkdtemp(join(tmpdir(), 'org-policy-live-smoke-'));
const workspace = join(temporary, 'workspace');
const home = join(temporary, 'home');
const codexHome = join(temporary, 'codex');
const dataDir = join(temporary, 'state');
await Promise.all([workspace, home, codexHome].map((path) => mkdir(path)));
// One-time isolated source setup, never per-L1 mutation of installed profiles.
execFileSync(
  join(skill, 'scripts/org-plan'),
  ['prepare-supervision', '--agents-dir', join(codexHome, 'agents')],
  { stdio: 'ignore' },
);
await writeFile(
  join(codexHome, 'config.toml'),
  `[features]\nmulti_agent = true\n[agents.org-plan-executor]\nconfig_file = ${JSON.stringify(join(codexHome, 'agents/org-plan-executor.toml'))}\n`,
);
const originalHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
try {
  await access(join(originalHome, 'auth.json'));
  await symlink(join(originalHome, 'auth.json'), join(codexHome, 'auth.json'));
} catch {
  /* Environment auth remains available. */
}
const planDirectory = join(workspace, '.gestalt');
await mkdir(planDirectory);
const planPath = join(planDirectory, 'policy-smoke.org');
await writeFile(
  planPath,
  `#+TITLE: Isolated policy smoke
#+SUBTITLE: Live source validation only
#+DATE: 2026-10-24
#+KEYWORDS: smoke
#+MODEL_POLICY_VERSION: 1
* TODO [#A] Write and verify sentinel
:PROPERTIES:
:ID: sentinel
:SKILLS: $bash-linux
:REVIEW_STATUS: UNREVIEWED
:MODEL: gpt-6.1-sol
:REASONING_EFFORT: medium
:MODEL_RATIONALE: Bounded smoke with exact output and direct verification.
:MODEL_FALLBACKS: none
:MODEL_ESCALATION_TRIGGER: Direct sentinel assertion fails.
:END:
- Effort :: Small
- Goal :: Write smoke.txt containing exactly supervised-execution-ok and a newline.
- Notes :: Only smoke.txt may change. Focused and full gate: python3 -c "from pathlib import Path; assert Path('smoke.txt').read_text() == 'supervised-execution-ok\\n'". Return the DONE L2 report to root before review. No Bitcoin files or source edits.
** TODO [#A] Produce sentinel
:PROPERTIES:
:ID: produce-sentinel
:END:
- Why :: Exercise a real canonical executor.
- Change :: Write smoke.txt in this workspace.
- Tests :: Run the exact Python assertion in L1 Notes.
- Done when :: Assertion passes and helper marks this L2 DONE.
`,
);
await writeFile(
  join(workspace, 'AGENTS.md'),
  `This is an authorized isolated supervised execution smoke.
Your first tool call must read ${join(skill, 'SKILL.md')} completely, alone.
Then read its supervised-execution, model-policy-workflow, executor-launch and effective-settings references.
Use exactly plan ${planPath}; helper ${join(skill, 'scripts/org-plan')}.
The user authorizes executing this smoke, tests and review; no further approval is needed.
Use this source contract, not an older installed Org-plan skill. Existing version-1 plans use configured assurance.
Runtime attestation is unavailable and is not a configured-mode prerequisite. Preserve unknown observations.
Validate and publish supervision-start; project the plan. Launch one default child task_name l1, fork_turns none,
model gpt-6.1-sol, reasoning_effort medium with full standalone executor duties and all exact source/plan/workspace paths.
The child must first read the source skill completely, then supervision reference, then optional bash-linux skill at
/home/gestalt-dyne/.agents/skills/bash-linux/SKILL.md before edits. That is its exact optional skill.
Only the child writes smoke.txt and helper lifecycle state. Parent supervises and verifies the assertion and scope.
After the child's DONE L2 report, inspect evidence, call gestalt_org_plan_health, then checkpoint l2Completed
as the last tool call and emit the mandatory boundary final. The harness stops after that acknowledged checkpoint.
Do not ask for progress approval, configure global profiles, modify Gestalt source, push or publish.
`,
);
execFileSync('git', ['init', '-q', workspace]);
execFileSync('git', ['-C', workspace, 'add', 'AGENTS.md']);
execFileSync('git', [
  '-C',
  workspace,
  '-c',
  'user.name=Smoke',
  '-c',
  'user.email=smoke@example.invalid',
  'commit',
  '-qm',
  'test: initialize isolated smoke',
]);
const counters = { modelStarts: 0, threadStartNotifications: 0 };
const app = await composeRelayApp({
  root: temporary,
  homeDirectory: home,
  dataDir,
  passkeyAuthEnabled: false,
  relyingParty: {
    publicOrigin: 'http://localhost:3000',
    rpId: 'localhost',
    rpName: 'Gestalt Mobile',
  },
  profiles: {
    list: async () => [],
    require: async () => ({ name: 'default', state: 'ok', status: 'ready' }),
  },
  installedCodexVersion: execFileSync('codex', ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim(),
  startAppServers: true,
  xerj: 'off',
  planMeasurementHelperPath: join(skill, 'scripts/org-plan'),
  launchAppServer: (input) => {
    const server = launchCodexAppServer({
      ...input,
      environment: { ...input.environment, CODEX_HOME: codexHome },
    });
    server.child.stderr.resume();
    const request = server.rpc.request.bind(server.rpc);
    server.rpc.request = async (method, params) => {
      if (method === 'turn/start') counters.modelStarts++;
      return request(method, params);
    };
    server.rpc.onNotification((notification) => {
      if (notification.method === 'thread/started') counters.threadStartNotifications++;
    });
    return server;
  },
});
let sessionId: string | null = null;
let outcome = 'deadline-before-checkpoint';
try {
  const bootstrap = (await app.inject('/api/bootstrap')).json();
  const entry = bootstrap.workspaces[0].children.find(
    (item: { name: string }) => item.name === 'workspace',
  );
  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: {
      workspaceId: entry.id,
      profile: 'default',
      provider: 'codex',
      model: 'gpt-6.1-sol',
      reasoningEffort: 'medium',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    },
  });
  if (created.statusCode !== 201 && created.statusCode !== 202)
    throw new Error('SMOKE_SESSION_CREATION_UNAVAILABLE');
  sessionId = created.json().id;
  const deadline = Date.now() + 180_000;
  let published = false;
  while (Date.now() < deadline) {
    const session = (await app.inject(`/api/sessions/${sessionId}`)).json();
    if (session.state === 'ready' && !published) {
      await writeFile(
        planStatusFilePath(planStatusDirectoryPath(workspace, sessionId!), planPath),
        JSON.stringify({
          schemaVersion: 1,
          planPath,
          reason: 'supervision-start',
          updatedAt: new Date().toISOString(),
          modelPolicyVersion: 1,
          requiredCapabilities: ['l1-model-policy-v1'],
        }),
      );
      await app.inject(`/api/sessions/${sessionId}/plan`);
      published = true;
    }
    if (published) {
      const db = new DatabaseSync(join(dataDir, 'relay.sqlite'));
      const checkpoint = db
        .prepare("SELECT count(*) AS n FROM session_events WHERE type='org-plan.step-checkpointed'")
        .get() as { n: number };
      db.close();
      if (checkpoint.n) {
        outcome = 'checkpoint-recorded';
        break;
      }
      if (session.pendingInteractions?.length && !session.activeTurnId) {
        outcome = 'interaction-required';
        break;
      }
      if (session.state === 'failed') {
        outcome = 'runtime-session-failed';
        break;
      }
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  let sentinel = false;
  try {
    sentinel =
      (await readFile(join(workspace, 'smoke.txt'), 'utf8')) === 'supervised-execution-ok\n';
  } catch {
    /* No file is a failed execution, not a success. */
  }
  const session = (await app.inject(`/api/sessions/${sessionId}`)).json();
  const canonicalExecutorObserved =
    session.agentActivity?.subagents?.some(
      (child: { canonicalTaskName?: string }) => child.canonicalTaskName === 'l1',
    ) === true;
  console.log(
    JSON.stringify({
      sourceSmoke: true,
      outcome,
      sentinel,
      canonicalExecutorObserved,
      ...counters,
      admission: session.autopilot?.executionAdmission ?? null,
      phase: session.autopilot?.health?.phase ?? null,
      installedUpdateVerified: false,
      interactions: (session.pendingInteractions ?? []).map(
        (interaction: {
          kind: string;
          payload?: { reason?: string; resumeCondition?: string };
          supervisorReport?: string;
        }) => ({
          kind: interaction.kind,
          reason: interaction.payload?.reason ?? null,
          resumeCondition: interaction.payload?.resumeCondition ?? null,
          limitationCategories: [
            'task_name',
            'fork_turns',
            'override',
            'attestation',
            'sandbox',
            'skill',
            'helper',
            'permission',
            'profile',
            'capability',
            'spawn',
          ].filter((term) => interaction.supervisorReport?.toLowerCase().includes(term)),
        }),
      ),
    }),
  );
  if (outcome !== 'checkpoint-recorded' || !sentinel || !canonicalExecutorObserved)
    process.exitCode = 1;
} catch (error) {
  console.log(
    JSON.stringify({
      sourceSmoke: true,
      outcome: 'unavailable',
      reason:
        error instanceof Error && /^SMOKE_/.test(error.message)
          ? error.message
          : 'isolated live source activation unavailable',
      ...counters,
      installedUpdateVerified: false,
    }),
  );
  process.exitCode = 1;
} finally {
  if (sessionId)
    await app.inject({
      method: 'PUT',
      url: `/api/sessions/${sessionId}/autopilot`,
      payload: { enabled: false },
    });
  await app.close();
  await rm(temporary, { recursive: true, force: true });
}
