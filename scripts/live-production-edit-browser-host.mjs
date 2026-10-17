/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { safeBrowserFailure } from './live-production-edit-diagnostics.mjs';

export async function productionEditBrowser(input) {
  assert.equal(process.env.LIVE_PRODUCTION_EDIT_FLOW_PROOF, '1');
  if (input.browser.startThroughControls)
    assert.equal(input.browser.startObservationBudgetMs, 815_000);
  if (!input.browser.preflight && !input.browser.startThroughControls)
    assert.equal(input.browser.eventObservationBudgetMs, 300_000);
  // Six serial event observation windows at the measured120s authority allowance,
  // plus180s for setup, manual draft, background and host-control exchanges.
  const browserDeadlineMs = input.browser.startThroughControls
    ? input.browser.startObservationBudgetMs + 60_000
    : input.browser.preflight
      ? 480_000
      : 6 * 120_000 + 180_000;
  const namespace = `l11edit-${process.pid}`;
  const hostInterface = `leh${process.pid}`;
  const peerInterface = `leb${process.pid}`;
  const hostAddress = '10.231.20.1';
  const browserAddress = '10.231.20.2';
  const home = join(
    input.privateRoot,
    input.browser.startThroughControls ? 'controls-start-browser' : 'edit-browser',
  );
  mkdirSync(join(home, '.pki/nssdb'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'tmp'), { mode: 0o700 });
  const run = (bin, args) => {
    try {
      return execFileSync(bin, args, { stdio: 'pipe', timeout: 30000 });
    } catch {
      throw new Error('EDIT_BROWSER_SETUP_UNAVAILABLE');
    }
  };
  const sudo = (args) => run('sudo', ['--non-interactive', ...args]);
  let browser;
  let networkCreated = false;
  try {
    input.report.editBrowserStage = 'network-setup';
    sudo(['ip', 'netns', 'add', namespace]);
    networkCreated = true;
    sudo(['ip', 'link', 'add', hostInterface, 'type', 'veth', 'peer', 'name', peerInterface]);
    sudo(['ip', 'link', 'set', peerInterface, 'netns', namespace]);
    sudo(['ip', 'address', 'add', `${hostAddress}/30`, 'dev', hostInterface]);
    sudo(['ip', 'link', 'set', hostInterface, 'up']);
    sudo([
      'ip',
      'netns',
      'exec',
      namespace,
      'ip',
      'address',
      'add',
      `${browserAddress}/30`,
      'dev',
      peerInterface,
    ]);
    sudo(['ip', 'netns', 'exec', namespace, 'ip', 'link', 'set', peerInterface, 'up']);
    sudo(['ip', 'netns', 'exec', namespace, 'ip', 'link', 'set', 'lo', 'up']);
    run('certutil', ['-N', '--empty-password', '-d', `sql:${home}/.pki/nssdb`]);
    run('certutil', [
      '-A',
      '-d',
      `sql:${home}/.pki/nssdb`,
      '-n',
      'L11 production edit proof',
      '-t',
      'C,,',
      '-i',
      input.certificate,
    ]);
    const serverNetwork = readlinkSync('/proc/self/ns/net');
    const serverMount = readlinkSync('/proc/self/ns/mnt');
    const browserNetwork = sudo(['ip', 'netns', 'exec', namespace, 'readlink', '/proc/self/ns/net'])
      .toString()
      .trim();
    assert.notEqual(serverNetwork, browserNetwork);
    const configPath = join(home, 'browser.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        ...input.browser,
        browserHome: home,
        hostAddress,
        serverNetwork,
        serverMount,
        browserNetwork,
      }),
      { mode: 0o600 },
    );
    browser = spawn(
      'sudo',
      [
        '--non-interactive',
        'ip',
        'netns',
        'exec',
        namespace,
        'unshare',
        '--mount',
        '--propagation',
        'private',
        '--',
        process.execPath,
        resolve('scripts/live-production-browser-namespace.mjs'),
        String(process.getuid()),
        String(process.getgid()),
        configPath,
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME, '.cache/ms-playwright'),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: home } },
    );
    // Raw browser errors may contain cookie/grant URLs. Only fixed checkpoints are retained.
    browser.stderr.on('data', (chunk) => {
      const fixed = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_ACCESS_DENIED'];
      input.report.editBrowserStartupCodes = fixed.filter((code) => String(chunk).includes(code));
    });
    let commandFailure = false;
    let commands = Promise.resolve();
    const lines = createInterface({ input: browser.stdout });
    lines.on('line', (line) => {
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        commandFailure = true;
        return;
      }
      if (typeof value.checkpoint === 'string' && /^[a-z-]{1,64}$/.test(value.checkpoint)) {
        input.report.editBrowserStage = value.checkpoint;
        if (
          Number.isSafeInteger(value.elapsedMs) &&
          value.elapsedMs >= 0 &&
          value.elapsedMs < browserDeadlineMs
        )
          (input.report.editBrowserStages ??= []).push({
            stage: value.checkpoint,
            elapsedMs: value.elapsedMs,
          });
        input.checkpoint?.(value.checkpoint);
      }
      if (
        /^[a-z-]{1,64}$/.test(value.failure?.stage ?? '') &&
        /^[A-Z][A-Z_]{1,63}$/.test(value.failure?.code ?? '')
      )
        input.report.editBrowserFailure = {
          stage: value.failure.stage,
          code: value.failure.code,
          diagnostic: safeBrowserFailure(value.failure.diagnostic),
          callsite:
            Number.isSafeInteger(value.failure.callsite?.line) &&
            Number.isSafeInteger(value.failure.callsite?.column)
              ? value.failure.callsite
              : null,
          chromeStartup: {
            components: value.failure.chromeStartup?.components
              ?.filter(
                (item) =>
                  /^[a-zA-Z0-9_./-]+\.(cc|h)$/.test(item.source) && Number.isSafeInteger(item.line),
              )
              .slice(0, 16),
            checks: value.failure.chromeStartup?.checks
              ?.filter(
                (item) =>
                  typeof item === 'string' &&
                  item.length <= 180 &&
                  /^[a-zA-Z0-9_().!<>=&| :+-]+$/.test(item),
              )
              .slice(0, 8),
            baselineSandboxedLaunch:
              typeof value.failure.chromeStartup?.baselineSandboxedLaunch === 'boolean'
                ? value.failure.chromeStartup.baselineSandboxedLaunch
                : undefined,
            launcherKernel: Object.fromEntries(
              Object.entries(value.failure.chromeStartup?.launcherKernel ?? {}).filter(
                ([name, value]) =>
                  [
                    'Uid',
                    'Gid',
                    'CapInh',
                    'CapPrm',
                    'CapEff',
                    'CapBnd',
                    'CapAmb',
                    'NoNewPrivs',
                    'Seccomp',
                  ].includes(name) &&
                  typeof value === 'string' &&
                  /^[0-9a-f ]{1,128}$/.test(value),
              ),
            ),
            exitCode: Number.isInteger(value.failure.chromeStartup?.exitCode)
              ? value.failure.chromeStartup.exitCode
              : null,
            signal: /^SIG[A-Z0-9]{1,12}$/.test(value.failure.chromeStartup?.signal ?? '')
              ? value.failure.chromeStartup.signal
              : null,
            markers: value.failure.chromeStartup?.markers?.filter((code) =>
              [
                'SANDBOX_UNAVAILABLE',
                'NAMESPACE',
                'SUID_SANDBOX',
                'ROOT_SANDBOX',
                'CRASHPAD',
                'CRASHPAD_DATABASE_REQUIRED',
                'SHARED_LIBRARY',
                'EACCES',
                'EPERM',
                'DISPLAY',
              ].includes(code),
            ),
          },
          markers: value.failure.markers?.filter((marker) =>
            [
              'Execution context was destroyed',
              'Target page, context or browser has been closed',
              'Navigation failed',
              'interrupted',
              'Timeout',
              'TypeError',
              'JSON',
            ].includes(marker),
          ),
          networkErrors: value.failure.networkErrors?.filter((code) =>
            /^net::ERR_[A-Z0-9_]{1,64}$/.test(code),
          ),
          exchangeStatuses: value.failure.exchangeStatuses?.filter(
            (item) =>
              ['/__gestalt_live/auth', '/__gestalt_live/exchange', '/'].includes(item.path) &&
              Number.isSafeInteger(item.status) &&
              item.status >= 100 &&
              item.status <= 599,
          ),
          resourcePending: Object.fromEntries(
            Object.entries(value.failure.resourcePending ?? {}).filter(
              ([key, count]) => /^[a-z]{1,24}$/.test(key) && Number.isSafeInteger(count),
            ),
          ),
          resourceStatuses: Object.fromEntries(
            Object.entries(value.failure.resourceStatuses ?? {}).filter(
              ([key, count]) =>
                /^[a-z]{1,24}:[1-5][0-9]{2}$/.test(key) && Number.isSafeInteger(count),
            ),
          ),
          pageErrors: value.failure.pageErrors?.slice(0, 8).map(safeBrowserFailure),
          helperBridge: Object.fromEntries(
            Object.entries(value.failure.helperBridge ?? {}).filter(
              ([key, item]) =>
                ['tokenPresent', 'tokenMatches', 'sameOrigin', 'correctPrefix'].includes(key) &&
                typeof item === 'boolean',
            ),
          ),
          editRequests: value.failure.editRequests
            ?.slice(-16)
            .filter(
              (item) =>
                ['generate', 'steer', 'accept', 'discard', 'manual_edit_apply'].includes(
                  item.kind,
                ) &&
                Number.isSafeInteger(item.elapsedMs) &&
                item.elapsedMs >= 0,
            ),
          helperResponses: value.failure.helperResponses?.slice(0, 24).map((item) => ({
            elapsedMs:
              Number.isSafeInteger(item.elapsedMs) && item.elapsedMs >= 0 ? item.elapsedMs : null,
            method: ['GET', 'POST'].includes(item.method) ? item.method : 'other',
            route: [
              'live.js',
              'events',
              'status',
              'lease',
              'agent-target-claim',
              'manual-edit-stash',
              'manual-edit-commit',
            ].includes(item.route)
              ? item.route
              : 'other',
            status: Number.isSafeInteger(item.status) ? item.status : null,
            gatewayHtml: item.gatewayHtml === true,
            helperTokenMatches:
              typeof item.helperTokenMatches === 'boolean' ? item.helperTokenMatches : null,
            cookiePresent: item.cookiePresent === true,
          })),
        };
      if (value.command)
        commands = commands.then(async () => {
          try {
            await input.command(value.command);
            browser.stdin.write(JSON.stringify({ ok: true }) + '\n');
          } catch {
            commandFailure = true;
            browser.stdin.write(JSON.stringify({ ok: false }) + '\n');
          }
        });
    });
    let timer;
    const exit = await Promise.race([
      new Promise((done) => browser.once('close', (code) => done(code))),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('EDIT_BROWSER_DEADLINE')), browserDeadlineMs);
      }),
    ]).finally(() => clearTimeout(timer));
    await commands;
    input.report.editBrowserExit = exit;
    input.report.editBrowserCommandFailure = commandFailure;
    assert.equal(commandFailure, false);
    assert.equal(exit, 0);
    const result = JSON.parse(readFileSync(input.browser.resultFile, 'utf8'));
    if (input.browser.preflight) {
      assert.equal(result.browserStartup, true);
      assert.equal(result.actualHiddenTab, true);
    } else assert.equal(result.trustedTls, true);
    assert.equal(result.separateBrowserNetwork, true);
    input.report.editBrowser = result;
  } finally {
    if (networkCreated) {
      const namespacePids = () =>
        sudo(['ip', 'netns', 'pids', namespace]).toString().trim().split(/\s+/).filter(Boolean);
      for (const signal of ['-TERM', '-KILL']) {
        const pids = namespacePids();
        assert.ok(pids.every((pid) => /^[1-9][0-9]*$/.test(pid)));
        if (!pids.length) break;
        try {
          sudo(['kill', signal, '--', ...pids]);
        } catch {
          // Processes can exit between the namespace inventory and the signal.
        }
        await new Promise((done) => setTimeout(done, 500));
      }
      input.report.editBrowserRemainingProcesses = namespacePids().length;
      assert.equal(input.report.editBrowserRemainingProcesses, 0);
    }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([
        new Promise((done) => browser.once('close', done)),
        new Promise((done) => setTimeout(done, 1000)),
      ]);
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
      browser.stdout.destroy();
      browser.stderr.destroy();
    }
    if (networkCreated) {
      const pids = sudo(['ip', 'netns', 'pids', namespace])
        .toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      assert.equal(pids.length, 0);
      sudo(['ip', 'link', 'delete', hostInterface]);
      sudo(['ip', 'netns', 'delete', namespace]);
    }
  }
}
