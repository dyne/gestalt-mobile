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

export async function productionEditBrowser(input) {
  assert.equal(process.env.LIVE_PRODUCTION_EDIT_FLOW_PROOF, '1');
  const namespace = `l11edit-${process.pid}`;
  const hostInterface = `leh${process.pid}`;
  const peerInterface = `leb${process.pid}`;
  const hostAddress = '10.231.20.1';
  const browserAddress = '10.231.20.2';
  const home = join(input.privateRoot, 'edit-browser');
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
        'setpriv',
        `--reuid=${process.getuid()}`,
        `--regid=${process.getgid()}`,
        '--init-groups',
        'env',
        `HOME=${home}`,
        `TMPDIR=${home}/tmp`,
        `PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.HOME, '.cache/ms-playwright')}`,
        process.execPath,
        resolve('scripts/live-production-edit-browser.mjs'),
        configPath,
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
        input.checkpoint?.(value.checkpoint);
      }
      if (
        /^[a-z-]{1,64}$/.test(value.failure?.stage ?? '') &&
        /^[A-Z][A-Z_]{1,63}$/.test(value.failure?.code ?? '')
      )
        input.report.editBrowserFailure = {
          stage: value.failure.stage,
          code: value.failure.code,
          callsite:
            Number.isSafeInteger(value.failure.callsite?.line) &&
            Number.isSafeInteger(value.failure.callsite?.column)
              ? value.failure.callsite
              : null,
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
            /^net::ERR_[A-Z_]{1,64}$/.test(code),
          ),
          exchangeStatuses: value.failure.exchangeStatuses?.filter(
            (item) =>
              ['/__gestalt_live/auth', '/__gestalt_live/exchange', '/'].includes(item.path) &&
              Number.isSafeInteger(item.status) &&
              item.status >= 100 &&
              item.status <= 599,
          ),
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
        timer = setTimeout(() => reject(new Error('EDIT_BROWSER_DEADLINE')), 240000);
      }),
    ]).finally(() => clearTimeout(timer));
    await commands;
    input.report.editBrowserExit = exit;
    input.report.editBrowserCommandFailure = commandFailure;
    assert.equal(commandFailure, false);
    assert.equal(exit, 0);
    const result = JSON.parse(readFileSync(input.browser.resultFile, 'utf8'));
    assert.equal(result.trustedTls, true);
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
