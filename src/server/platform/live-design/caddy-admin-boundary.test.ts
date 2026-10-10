/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ManagedCaddyAdminBoundary,
  protectCaddyControllerState,
  type ManagedProjectSandboxState,
} from './caddy-admin-boundary.js';
import { CaddyRouteBroker } from './caddy-route-broker.js';
import { CaddyRoutes } from './caddy-routes.js';
import { CaddyRouteStore } from './caddy-route-store.js';
import { RegisteredPreviewTargets } from './preview-targets.js';
import { UnixCaddyAdmin } from './caddy-admin.js';
import { realCaddyFixture } from './caddy-routes.fixture.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function effectivePolicy(projectDirectory: string): ManagedProjectSandboxState {
  return {
    permissionProfile: {
      type: 'managed',
      file_system: {
        type: 'restricted',
        entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          { path: { type: 'path', path: projectDirectory }, access: 'write' },
          { path: { type: 'special', value: { kind: 'slash_tmp' } }, access: 'write' },
        ],
      },
      network: 'enabled',
    },
    sandboxCwd: pathToFileURL(projectDirectory).href,
    useLegacyLandlock: false,
  };
}
describe('Caddy private controller boundary', () => {
  it('retains inherited permission entries while excluding private controller state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-controller-policy-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const inherited = effectivePolicy(dir);
    const protectedState = protectCaddyControllerState(inherited, dir);
    expect(protectedState.permissionProfile.file_system.entries.slice(0, -1)).toEqual(
      inherited.permissionProfile.file_system.entries,
    );
    expect(protectedState.permissionProfile.file_system.entries.at(-1)).toEqual({
      path: { type: 'path', path: dir },
      access: 'deny',
    });
    expect(inherited.permissionProfile.file_system.entries).toHaveLength(3);
  });
  it('rejects unprotected actual policies, unauthorized controllers and arbitrary broker commands before IO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'live-controller-policy-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const socket = join(dir, 'socket');
    const credentialPath = join(dir, 'credential');
    await writeFile(socket, 'fixture');
    await writeFile(credentialPath, 'fixture');
    const boundary = new ManagedCaddyAdminBoundary({
      codexExecutable: '/not-invoked',
      projectDirectory: dir,
      controllerDirectory: dir,
      socketPath: socket,
      credentialPath,
      effectiveSandboxState: () => effectivePolicy(dir),
    });
    await expect(boundary.verify()).rejects.toThrow('LIVE_CADDY_ADMIN_UNISOLATED');
    const store = new CaddyRouteStore(join(dir, 'routes.sqlite'), 'preview.example.test', [24443], {
      initialize: true,
    });
    cleanup.push(() => store.close());
    const broker = new CaddyRouteBroker(
      'a'.repeat(64),
      new CaddyRoutes(new UnixCaddyAdmin(socket), store, new RegisteredPreviewTargets()),
      boundary,
    );
    await expect(broker.execute('wrong', { action: 'reconcile' })).rejects.toThrow(
      'LIVE_CADDY_CONTROLLER_REQUIRED',
    );
    await expect(broker.execute('a'.repeat(64), { action: 'load', config: {} })).rejects.toThrow(
      'LIVE_CADDY_OPERATION_REJECTED',
    );
    await expect(
      broker.execute('a'.repeat(64), {
        action: 'activate',
        appRoot: dir,
        registrationId: 'http://127.0.0.1:2019',
      }),
    ).rejects.toThrow('LIVE_CADDY_OPERATION_REJECTED');
    await expect(
      broker.execute('a'.repeat(64), { action: 'reconcile', socketPath: '/etc/socket' }),
    ).rejects.toThrow('LIVE_CADDY_OPERATION_REJECTED');
    await expect(broker.execute('a'.repeat(64), { action: 'reconcile' })).rejects.toThrow(
      'LIVE_CADDY_ADMIN_UNISOLATED',
    );
  });
});

describe.runIf(process.env.LIVE_NATIVE_CADDY_PROOF === '1')(
  'actual native managed-project Caddy denial',
  () => {
    it('denies actual same-UID project socket/proc-root/credential access, permits only authenticated scoped operations, and repeats after restart', async () => {
      const f = await realCaddyFixture();
      cleanup.push(() => f.close());
      const credential = randomBytes(32).toString('hex');
      const credentialPath = join(f.controllerDirectory, 'broker-credential');
      await writeFile(credentialPath, credential, { mode: 0o600 });
      const sandboxHome = join(f.controllerDirectory, 'codex');
      await mkdir(sandboxHome, { mode: 0o700 });
      const policy = protectCaddyControllerState(
        effectivePolicy(f.appRoots[0]!),
        f.controllerDirectory,
      );
      const boundary = new ManagedCaddyAdminBoundary({
        codexExecutable: process.env.LIVE_TEST_CODEX ?? 'codex',
        projectDirectory: f.appRoots[0]!,
        controllerDirectory: f.controllerDirectory,
        socketPath: f.socket,
        credentialPath,
        effectiveSandboxState: () => policy,
        sandboxEnvironment: {
          PATH: process.env.PATH,
          CODEX_HOME: sandboxHome,
          HOME: process.env.HOME,
        },
      });
      const proof = await boundary.verify();
      expect(proof.uid).toBe(process.getuid!());
      const store = new CaddyRouteStore(
        join(f.controllerDirectory, 'routes.sqlite'),
        'preview.example.test',
        f.ports,
        { initialize: true },
      );
      cleanup.push(() => store.close());
      const targets = new RegisteredPreviewTargets();
      const id = targets.register({
        appRoot: f.appRoots[0]!,
        appPort: 31231,
        helperPort: 31232,
        gatewayPort: f.gatewayPort,
      });
      const broker = new CaddyRouteBroker(
        credential,
        new CaddyRoutes(f.admin, store, targets),
        boundary,
      );
      const assigned = await broker.execute(credential, {
        action: 'activate',
        appRoot: f.appRoots[0]!,
        registrationId: id,
      });
      expect(assigned).toHaveProperty('serverId');
      await f.stop();
      await f.start();
      const restartProof = await boundary.verify();
      await broker.execute(credential, { action: 'reconcile' });
      await broker.execute(credential, { action: 'remove', appRoot: f.appRoots[0]! });
      if (process.env.LIVE_CADDY_EVIDENCE_DIR) {
        await mkdir(process.env.LIVE_CADDY_EVIDENCE_DIR, { recursive: true });
        await writeFile(
          join(process.env.LIVE_CADDY_EVIDENCE_DIR, 'actual-project-denial.json'),
          JSON.stringify(
            {
              actualManagedProject: true,
              sameEffectiveUid: proof.uid === process.getuid!(),
              nativeSandbox: true,
              directAdminDenied: true,
              procRootAdminDenied: true,
              brokerCredentialDenied: true,
              noAlternateUid: true,
              beforeRestart: proof,
              afterRestart: restartProof,
              authenticatedNamespacedActivationReconcileTeardown: true,
            },
            null,
            2,
          ),
        );
      }
    }, 60000);
  },
);
