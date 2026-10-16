/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RegisteredDevServers } from '../dist/server/server/platform/live-design/registered-dev-servers.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function registeredExternal(privateRoot) {
  const app = join(privateRoot, 'external-app');
  mkdirSync(app, { mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import{createServer}from'node:http';const server=createServer((_,r)=>r.end('external-server-survived'));server.listen(0,'127.0.0.1',()=>console.log(server.address().port));",
    ],
    {
      cwd: app,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const exited = new Promise((resolve) => child.once('close', resolve));
  child.on('error', () => {});
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    let deadline;
    try {
      await Promise.race([
        exited,
        new Promise((done) => {
          deadline = setTimeout(done, 5000);
        }),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    } finally {
      clearTimeout(deadline);
    }
  };
  let timer;
  try {
    const port = await Promise.race([
      new Promise((resolve) =>
        child.stdout.once('data', (bytes) => resolve(Number(bytes.toString().trim()))),
      ),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('EXTERNAL_SERVER_STARTUP_DEADLINE')), 5000);
      }),
    ]);
    assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
    const registry = new RegisteredDevServers();
    const target = registry.register(app, port, child.pid);
    const verify = async () => {
      assert.deepEqual(registry.read(target.targetId, target.app).identity, target.identity);
      assert.equal(
        await (
          await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(5000) })
        ).text(),
        'external-server-survived',
      );
    };
    await verify();
    return {
      verify,
      target,
      close: async () => {
        registry.unregister(target.targetId);
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
/** Hosted assertions around the actual production endpoints. No readiness,
 * observation, model, helper or receipt implementation is replaced here. */
export async function productionRecoveryProof(input) {
  const {
    api,
    inject,
    remote,
    until,
    report,
    session,
    started,
    controller,
    appRoot,
    signed,
    authenticate,
    owningBirthExited,
    ownedProcesses,
  } = input;
  const external = await registeredExternal(input.privateRoot);
  try {
    const prefix = `/api/sessions/${session.id}/live`;
    const stage = (value) => {
      report.stage = `recovery-${value}`;
    };
    const fencePath = join(controller, `runtime-admission-${hash(appRoot)}.json`);
    const source = () => readFileSync(join(appRoot, 'index.html'), 'utf8');
    const userSource = () =>
      source()
        .replace(/<!-- impeccable-live-start -->[\s\S]*?<!-- impeccable-live-end -->/g, '')
        .trim();
    const requestCount = report.provider.requestCount;
    const state = () => api('GET', prefix);
    const currentCapture = (run) => {
      const fence = signed(fencePath);
      assert.equal(fence.generation.generation, run.generation);
      const candidates = readdirSync(controller)
        .filter((name) => name.startsWith('owner-'))
        .map((name) => join(controller, name));
      const directory = candidates.find((path) => {
        const manifest = JSON.parse(readFileSync(join(path, 'manifest.json')));
        return manifest.runtimeProvenance?.captureId === fence.captureId;
      });
      assert.ok(directory);
      const manifestBytes = readFileSync(join(directory, 'manifest.json'));
      const sealed = signed(join(directory, `runtime-${fence.captureId}.json`));
      assert.equal(sealed.inventory.observation.accountDigest.length, 64);
      assert.equal(sealed.inventory.observation.sessionFlags.model, session.model);
      assert.equal(
        sealed.inventory.observation.sessionFlags.reasoningEffort,
        session.modelSettings.reasoningEffort,
      );
      assert.equal(
        sealed.inventory.sessionFlagsDigest,
        hash(
          JSON.stringify(sealed.inventory.observation.sessionFlags, (_key, item) =>
            item && typeof item === 'object' && !Array.isArray(item)
              ? Object.fromEntries(
                  Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
                )
              : item,
          ),
        ),
      );
      return { directory, manifestDigest: hash(manifestBytes), captureId: fence.captureId, sealed };
    };
    const assertArchived = (capture) =>
      assert.equal(
        hash(readFileSync(join(capture.directory, 'manifest.json'))),
        capture.manifestDigest,
      );
    const original = currentCapture(started);
    stage('real-network-disconnect');
    let disconnected;
    await until(
      async () => {
        disconnected = await state();
        return disconnected.state === 'recoveryRequired';
      },
      'RECOVERY_BROWSER_DISCONNECT_DEADLINE',
      30000,
    );
    report.recoveryDisconnect = {
      originalGeneration: started.generation,
      recoveryGeneration: disconnected.generation,
      initialSignedStatus: signed(fencePath).status,
    };
    assert.ok(disconnected.generation > started.generation);
    // The denial state is durable before the asynchronous Manager invocation
    // returns. Require the actual authenticated revocation, not state alone.
    await until(
      () => signed(fencePath).status === 'revoked',
      'RECOVERY_SIGNED_REVOCATION_DEADLINE',
      30000,
    );
    report.recoveryDisconnect.signedRevocationObserved = true;
    const beforeResume = userSource();
    stage('survivor-renewal');
    const attempts = await Promise.all(
      [0, 1].map(() =>
        inject('POST', `${prefix}/resume`, {
          liveId: disconnected.liveId,
          generation: disconnected.generation,
        }),
      ),
    );
    report.recoveryResumeReplies = attempts.map((reply) => {
      const body = reply.json();
      return {
        status: reply.statusCode,
        code: /^LIVE_[A-Z_]{1,80}$/.test(body.code ?? '') ? body.code : undefined,
        state: ['active', 'recoveryRequired', 'stopping', 'starting', 'idle', 'error'].includes(
          body.state,
        )
          ? body.state
          : undefined,
        generation: Number.isSafeInteger(body.generation) ? body.generation : undefined,
      };
    });
    report.recoveryStateAfterResume = await state();
    assert.equal(attempts.filter((reply) => reply.statusCode === 200).length, 1);
    assert.equal(attempts.filter((reply) => reply.statusCode === 409).length, 1);
    const survivor = attempts.find((reply) => reply.statusCode === 200).json();
    assert.equal(survivor.state, 'active');
    assert.ok(survivor.generation > disconnected.generation);
    assert.equal(survivor.liveId, started.liveId);
    const surviving = currentCapture(survivor);
    assert.equal(surviving.sealed.runtime.process.pid, original.sealed.runtime.process.pid);
    assert.equal(surviving.sealed.runtime.process.birth, original.sealed.runtime.process.birth);
    assert.equal(
      surviving.sealed.inventory.observation.accountDigest,
      original.sealed.inventory.observation.accountDigest,
    );
    assertArchived(original);
    assert.equal(userSource(), beforeResume);
    assert.equal(report.provider.requestCount, requestCount);
    const oldCookieDenied = await remote('/').then(
      (response) => response.status !== 200,
      () => true,
    );
    assert.equal(oldCookieDenied, true);
    const survivorStream = await authenticate(survivor);
    const stale = await inject('POST', `${prefix}/resume`, {
      liveId: disconnected.liveId,
      generation: disconnected.generation,
    });
    assert.equal(stale.statusCode, 409);
    report.checks.productionSurvivorRenewalPreservesOriginalBirthAndSelections = true;
    report.checks.oldCookiesAndStaleResumeCannotRegrant = true;
    report.checks.concurrentProductionResumeHasOneGenerationAndOneOwner = true;

    stage('actual-owning-native-death');
    // Before killing this exact owned birth, prove the sole canonical poll is
    // waiting after its real Native idle observation. No event/model is injected.
    const inbox = readdirSync(controller).filter((name) =>
      /^inbox-[a-f0-9]{64}\.sqlite$/.test(name),
    );
    assert.equal(inbox.length, 1);
    await until(
      () => {
        const db = new DatabaseSync(join(controller, inbox[0]), { readOnly: true });
        try {
          return db
            .prepare("SELECT 1 FROM live_poll_intents WHERE generation=? AND phase='polling'")
            .get(survivor.generation);
        } finally {
          db.close();
        }
      },
      'RECOVERY_IDLE_CANONICAL_POLL_DEADLINE',
      15000,
    );
    assert.equal(owningBirthExited(surviving.sealed.runtime.process), false);
    process.kill(surviving.sealed.runtime.process.pid, 'SIGTERM');
    await until(
      () => owningBirthExited(surviving.sealed.runtime.process),
      'RECOVERY_OWNING_EXIT_DEADLINE',
      10000,
    );
    survivorStream.destroy();
    let dead;
    await until(
      async () => {
        dead = await state();
        return dead.state === 'recoveryRequired';
      },
      'RECOVERY_PROCESS_DEATH_DEADLINE',
      30000,
    );
    stage('replacement-renewal');
    const replacement = await api('POST', `${prefix}/resume`, {
      liveId: dead.liveId,
      generation: dead.generation,
    });
    assert.equal(replacement.state, 'active');
    const replaced = currentCapture(replacement);
    assert.notEqual(replaced.sealed.runtime.process.pid, surviving.sealed.runtime.process.pid);
    assert.equal(
      replaced.sealed.inventory.observation.accountDigest,
      original.sealed.inventory.observation.accountDigest,
    );
    assertArchived(original);
    assertArchived(surviving);
    assert.equal(report.provider.requestCount, requestCount);
    const replacementStream = await authenticate(replacement);
    report.checks.productionReplacementRequiresActualExitAndFreshOwningObservation = true;

    stage('concurrent-stop');
    const stopped = await Promise.all(
      [0, 1].map(() =>
        api('POST', `${prefix}/stop`, {
          liveId: replacement.liveId,
          generation: replacement.generation,
        }),
      ),
    );
    assert.ok(
      stopped.every((run) => run.state === 'idle' && run.generation === replacement.generation),
    );
    await until(
      () => replacementStream.destroyed || replacementStream.readableEnded,
      'RECOVERY_OLD_STREAM_CLOSE_DEADLINE',
      10000,
    );
    assert.equal(signed(fencePath).status, 'revoked');
    assert.ok(
      ownedProcesses().every((proof) => proof.namespaceExited && proof.pipeDescriptorsClosed),
    );
    assert.equal(existsSync(join(appRoot, '.impeccable/live/inject-journal.json')), false);
    assert.equal(existsSync(join(appRoot, '.impeccable/live/server.json')), false);
    const stoppedSource = source();
    assert.ok(stoppedSource.includes(input.expectedSourceText ?? 'Production manual approved'));
    assert.ok(!stoppedSource.includes('__IMPECCABLE_LIVE'));
    assert.equal(
      (await remote('/').then(
        (response) => response.status,
        () => 0,
      )) === 200,
      false,
    );
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(source(), stoppedSource);
    assert.equal(report.provider.requestCount, requestCount);
    const current = await api('GET', `/api/sessions/${session.id}`);
    assert.equal(current.threadId, session.threadId);
    assert.equal(current.model, session.model);
    assert.deepEqual(current.modelSettings, session.modelSettings);
    assert.deepEqual(current.executionPolicy, session.executionPolicy);
    report.checks.concurrentProductionStopRevokesDrainsAndRestoresOriginalConfiguration = true;
    report.checks.noModelTurnOrSourceEditAfterStop = true;
    await external.verify();
    const externalAdmission = await inject('POST', `${prefix}/start`, {
      appId: 'owning-app',
      targetId: external.target.targetId,
      operationId: 'external-refused',
    });
    assert.equal(externalAdmission.statusCode, 503);
    assert.equal(externalAdmission.json().code, 'LIVE_TARGET_UNREGISTERED');
    await external.verify();
    report.checks.realRegisteredExternalServerSurvivesWithoutAdoption = true;
    report.recovery = {
      genuineProvider: false,
      actualProductionEndpoints: true,
      generations: [
        started.generation,
        disconnected.generation,
        survivor.generation,
        dead.generation,
        replacement.generation,
      ],
      captures: [original.captureId, surviving.captureId, replaced.captureId],
      originalBirthPreservedDuringSurvivor: true,
      replacementBirthAfterActualExit: true,
      originalManifestBytesPreserved: true,
      durableInboxRemainsSharedAcrossGenerations: true,
    };
    return { latestCaptureId: replaced.captureId, stopped: stopped[0] };
  } finally {
    await external.close();
  }
}
