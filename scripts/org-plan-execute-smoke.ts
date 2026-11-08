/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// Opt-in real root-turn boundary. No installed configuration, skill or profile writes.
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { composeRelayApp } from '../src/server/composition.js';
import { LauncherProfileCatalog } from '../src/server/platform/catalog/launcher-profile-catalog.js';
import { launchCodexAppServer } from '../src/server/platform/codex/codex-process-launcher.js';
import { isMissingCodexThreadRollout } from '../src/server/platform/codex/json-rpc-client.js';
import {
  planStatusDirectoryPath,
  planStatusFilePath,
} from '../src/server/platform/plans/filesystem-plan-status-source.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error('SMOKE_ARGUMENT_REQUIRED');
  return resolve(process.argv[index + 1]!);
}
if (!process.argv.includes('--execute'))
  throw new Error('Explicit --execute required: this smoke consumes one real model turn.');
const skill = argument('--org-plan-skill');
const reportPath = argument('--report');
const helper = join(skill, 'scripts', 'org-plan');
await access(helper, constants.X_OK);
await access(join(skill, 'SKILL.md'));

const report: Record<string, unknown> = {
  version: 1,
  sourceSmoke: true,
  startedAt: new Date().toISOString(),
  outcome: 'unavailable',
  bootstrapAccepted: false,
  supervisionStartObserved: false,
  owningHelperSucceeded: false,
  modelAdoptionObserved: false,
  installedDeliveryVerified: false,
};
const observedHelpers: Array<{
  threadId: string;
  itemId: string;
  exitCode: number;
  commandSha256: string;
  observedAt: string;
}> = [];
let root: string | undefined;
let app: Awaited<ReturnType<typeof composeRelayApp>> | undefined;
let sessionId: string | undefined;
let threadId: string | undefined;
let modelStarts = 0;
let activatingAttachments = 0;
let autopilotToggleRequests = 0;
let cleanupComplete = false;
let executionAttempted = false;
const createdThreads = new Set<string>();
report.stage = 'prerequisites';
try {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (
    version.error ||
    version.status !== 0 ||
    !/^codex-cli \d+\.\d+\.\d+$/.test(version.stdout.trim())
  )
    throw new Error('NATIVE_CODEX_UNAVAILABLE');
  report.codexVersion = version.stdout.trim();
  root = await mkdtemp(join(tmpdir(), 'org-plan-execute-native-'));
  const workspace = join(root, 'project');
  await mkdir(join(workspace, '.gestalt'), { recursive: true });
  const planPath = join(workspace, '.gestalt', 'native execute ü.org');
  const source =
    '#+TITLE: Native Execute launch boundary\n* TODO [#A] Reserved smoke milestone\n:PROPERTIES:\n:ID: reserved-smoke\n:SKILLS: $gestalt:org-plan\n:REVIEW_STATUS: UNREVIEWED\n:END:\n- Effort :: Small\n- Goal :: Verify the ordinary root can load and publish this exact plan.\n- Notes :: This harness authorizes only loading and supervision-start publication; no milestone execution or child launch.\n';
  await writeFile(planPath, source);
  await writeFile(
    join(workspace, 'AGENTS.md'),
    [
      'This is an authorized, bounded native launch smoke in an isolated project.',
      `Your first tool call must read ${join(skill, 'SKILL.md')} completely and alone.`,
      `Use the existing helper ${helper} and exactly this plan: ${planPath}.`,
      'Load the required supervised execution instructions, validate this plan, and use the real helper to publish supervision-start.',
      'After publication, stop. This smoke authorizes no milestone transitions, source changes, executor spawn, commits, deployment, installation or permission changes.',
      'Do not write status files yourself. The harness observes your real helper publication and then stops this ordinary session.',
    ].join('\n') + '\n',
  );
  const initialized = spawnSync('git', ['init', '-q', workspace], {
    stdio: 'ignore',
    timeout: 5000,
  });
  if (initialized.error || initialized.status !== 0) throw new Error('NATIVE_GIT_UNAVAILABLE');
  report.stage = 'composition';
  app = await composeRelayApp({
    root,
    dataDir: join(root, 'state'),
    passkeyAuthEnabled: false,
    relyingParty: {
      publicOrigin: 'http://localhost:3000',
      rpId: 'localhost',
      rpName: 'Gestalt Mobile',
    },
    profiles: new LauncherProfileCatalog(),
    installedCodexVersion: version.stdout.trim(),
    startAppServers: true,
    // No indexing/service installation is part of this bounded native boundary.
    xerj: 'off',
    launchAppServer: (input) => {
      const server = launchCodexAppServer(input);
      const request = server.rpc.request.bind(server.rpc);
      server.rpc.request = async (method, params) => {
        if (method === 'turn/start') modelStarts++;
        const result = await request(method, params);
        if (method === 'thread/start') {
          const id = (result as { thread?: { id?: unknown } })?.thread?.id;
          if (typeof id === 'string') createdThreads.add(id);
        }
        return result;
      };
      server.rpc.onNotification((notification) => {
        if (notification.method !== 'item/completed') return;
        const params = notification.params as {
          threadId?: unknown;
          item?: { id?: unknown; type?: unknown; command?: unknown; exitCode?: unknown };
        };
        const item = params?.item;
        if (
          typeof params?.threadId === 'string' &&
          item?.type === 'commandExecution' &&
          typeof item.command === 'string' &&
          item.command.includes(helper) &&
          item.command.includes(planPath) &&
          item.command.includes('supervision-start') &&
          typeof item.exitCode === 'number' &&
          observedHelpers.length < 64
        )
          observedHelpers.push({
            threadId: params.threadId,
            itemId: typeof item.id === 'string' ? item.id : 'unknown',
            exitCode: item.exitCode,
            commandSha256: createHash('sha256').update(item.command).digest('hex'),
            observedAt: new Date().toISOString(),
          });
      });
      return server;
    },
  });
  app.addHook('onRequest', async (request) => {
    if (request.url.endsWith('/autopilot') && request.method === 'PUT') autopilotToggleRequests++;
    if (request.url.endsWith('/plan') && request.method === 'PUT') activatingAttachments++;
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const catalog = (await app.inject('/api/bootstrap')).json();
  const project = catalog.workspaces[0]?.children.find(
    (entry: { name: string }) => entry.name === 'project',
  );
  if (!project) throw new Error('NATIVE_WORKSPACE_UNAVAILABLE');
  const reference = {
    kind: 'workspace',
    workspaceId: project.id,
    planName: '.gestalt/native execute ü.org',
  };
  report.stage = 'preparation';
  const prepared = (
    await app.inject({ method: 'POST', url: '/api/plans/prepare', payload: reference })
  ).json();
  if (prepared.kind !== 'eligible') {
    report.preparationCode = typeof prepared.code === 'string' ? prepared.code : 'UNKNOWN';
    report.preparationReason =
      typeof prepared.reason === 'string' ? prepared.reason.slice(0, 600) : null;
    throw new Error('NATIVE_PREPARATION_BLOCKED');
  }
  report.workspaceMatched = prepared.workspace.path === workspace;
  report.settings = {
    model: prepared.settings.model,
    reasoningEffort: prepared.settings.reasoningEffort,
    executorModel: prepared.settings.executorModel,
    executorReasoningEffort: prepared.settings.executorReasoningEffort,
    sandbox: prepared.settings.sandbox,
    approvalPolicy: prepared.settings.approvalPolicy,
    skillProfile: prepared.settings.skillProfile,
  };
  const launchId = `native-${randomUUID()}`;
  report.stage = 'execution';
  executionAttempted = true;
  const response = await app.inject({
    method: 'POST',
    url: '/api/plans/execute',
    payload: {
      reference,
      expectedRevision: prepared.revision,
      skillProfile: prepared.settings.skillProfile,
      launchId,
    },
  });
  const result = response.json();
  if (result.session?.id) {
    sessionId = result.session.id;
    threadId = result.session.threadId;
  }
  report.launchKind = result.kind;
  report.launchStage = result.stage ?? null;
  report.sessionId = sessionId ?? null;
  report.rootThreadId = threadId ?? null;
  if (result.kind !== 'started' || result.bootstrap?.kind !== 'accepted')
    throw new Error('NATIVE_BOOTSTRAP_NOT_ACCEPTED');
  report.bootstrapAccepted = true;
  report.outcome = 'deadline-before-supervision-start';
  report.bootstrap = result.bootstrap;
  report.rosterMatched =
    (await app.inject('/api/sessions')).json().filter((row: { id: string }) => row.id === sessionId)
      .length === 1;
  const deadline = Date.now() + 90000;
  report.stage = 'observation';
  while (Date.now() < deadline) {
    const current = (await app.inject(`/api/sessions/${sessionId}`)).json();
    if (
      current.lastOrgPlan?.path === planPath &&
      current.lastOrgPlan.attached &&
      current.autopilot?.enabled
    ) {
      const raw = await readFile(
        planStatusFilePath(planStatusDirectoryPath(workspace, sessionId!), planPath),
      );
      const status = JSON.parse(raw.toString());
      if (status.reason === 'supervision-start' && status.planPath === planPath) {
        report.supervisionStartObserved = true;
        report.statusSha256 = createHash('sha256').update(raw).digest('hex');
        await writeFile(`${reportPath}.status.json`, raw);
        report.outcome = 'supervision-start-observed';
        break;
      }
    }
    if (current.pendingInteractions?.length) {
      report.interactionKinds = current.pendingInteractions.map(
        (entry: { kind: string }) => entry.kind,
      );
      throw new Error('NATIVE_INTERACTION_REQUIRED');
    }
    if (!current.activeTurnId) {
      report.outcome = 'root-completed-without-supervision-start';
      break;
    }
    await new Promise<void>((done) => setTimeout(done, 500));
  }
  const history = await app.inject(`/api/sessions/${sessionId}/history`);
  report.historyAvailable = history.statusCode === 200;
  if (history.statusCode === 200) {
    const body = history.json();
    report.bootstrapHistoryCount = Array.isArray(body.items)
      ? body.items.filter(
          (item: { kind?: string; operationId?: string; text?: string }) =>
            item.kind === 'user' &&
            (item.operationId === result.bootstrap.requestId ||
              (typeof item.text === 'string' &&
                item.text.includes(planPath) &&
                item.text.includes('gestalt:org-plan'))),
        ).length
      : null;
  }
  report.owningHelperSucceeded = observedHelpers.some(
    (event) => event.threadId === threadId && event.exitCode === 0,
  );
  report.modelAdoptionObserved =
    report.supervisionStartObserved === true && report.owningHelperSucceeded === true;
  report.planSourceUnchanged = (await readFile(planPath, 'utf8')) === source;
  report.acceptedBootstrapReplay =
    (
      await app.inject({
        method: 'POST',
        url: '/api/plans/execute',
        payload: {
          reference,
          expectedRevision: prepared.revision,
          skillProfile: prepared.settings.skillProfile,
          launchId,
        },
      })
    ).json().session?.id === sessionId;
  if (
    report.supervisionStartObserved !== true ||
    report.owningHelperSucceeded !== true ||
    modelStarts !== 1 ||
    report.planSourceUnchanged !== true ||
    report.rosterMatched !== true ||
    report.workspaceMatched !== true ||
    report.historyAvailable !== true ||
    report.bootstrapHistoryCount !== 1 ||
    report.acceptedBootstrapReplay !== true ||
    autopilotToggleRequests ||
    activatingAttachments
  )
    process.exitCode = 1;
} catch (error) {
  report.limitation =
    error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
      ? error.message
      : 'NATIVE_SMOKE_UNAVAILABLE';
  process.exitCode = 1;
} finally {
  try {
    try {
      if (sessionId && app) {
        const stopped = await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/stop`,
          payload: {},
        });
        report.stopStatus = stopped.statusCode;
        const forgotten = await app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` });
        report.forgetStatus = forgotten.statusCode;
        report.forgetConfirmed = forgotten.statusCode === 204;
        if (forgotten.statusCode !== 204) throw new Error('OWNED_SESSION_FORGET_UNCONFIRMED');
        if (stopped.statusCode !== 202) process.exitCode = 1;
      } else if (executionAttempted) {
        throw new Error('OWNED_PUBLICATION_CLEANUP_UNCONFIRMED');
      }
    } finally {
      await app?.close();
    }
    if (createdThreads.size && root) {
      const cleanup = launchCodexAppServer({ profile: 'default', cwd: root });
      const deadline = setTimeout(() => cleanup.close(), 15000);
      try {
        await cleanup.rpc.request('initialize', {
          clientInfo: { name: 'execute-smoke-cleanup', version: '1' },
          capabilities: { experimentalApi: true },
        });
        for (const createdThreadId of createdThreads) {
          try {
            await cleanup.rpc.request('thread/delete', { threadId: createdThreadId });
            try {
              await cleanup.rpc.request('thread/read', {
                threadId: createdThreadId,
                includeTurns: false,
              });
              throw new Error('OWNED_THREAD_DELETE_UNCONFIRMED');
            } catch (error) {
              if (!isMissingCodexThreadRollout(error)) throw error;
            }
          } catch (error) {
            if (!isMissingCodexThreadRollout(error)) throw error;
          }
        }
      } finally {
        clearTimeout(deadline);
        await cleanup.closeAndWait();
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
    cleanupComplete = true;
  } catch (error) {
    report.cleanupLimitation =
      error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message)
        ? error.message
        : 'OWNED_SMOKE_CLEANUP_UNCONFIRMED';
    report.retainedTemporaryRoot = root ?? null;
    report.retainedOwnedThreads = [...createdThreads];
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  report.modelStarts = modelStarts;
  report.activatingAttachments = activatingAttachments;
  report.autopilotToggleRequests = autopilotToggleRequests;
  report.cleanupComplete = cleanupComplete;
  report.createdThreadCount = createdThreads.size;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile(`${reportPath}.events.json`, JSON.stringify(observedHelpers, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
