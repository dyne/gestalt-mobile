/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import {
  launchCodexAppServer,
  type CodexProcess,
} from '../../src/server/platform/codex/codex-process-launcher.js';
import { CodexSessionRuntime } from '../../src/server/platform/codex/session-runtime.js';
import {
  CodexPlaywright,
  type PlaywrightAuthority,
} from '../../src/server/platform/codex/codex-playwright.js';
import { ManagedPlaywright } from '../../src/server/platform/codex/managed-playwright.js';
import {
  RelaySession,
  type RelaySessionSnapshot,
} from '../../src/server/features/sessions/model/relay-session.js';
import type { CodexRetrievalState } from '../../src/server/platform/retrieval/codex-xerj.js';
import { isManagedPlaywrightCall } from '../../src/shared/contracts/managed-playwright.js';
import { seedWithNativeCli } from './fixtures/playwright-native-cli.js';
import { prepareOfflineUpdate } from './fixtures/playwright-offline-update.js';

type WireTool = { name: string; namespace?: string };
type WireInput = { role?: string; type?: string; output?: unknown };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(description);
    await pause(25);
  }
}
function text(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return text(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(text).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(text).join('\n');
  return '';
}
async function processTree(pid: number) {
  const rows: { pid: number; parent: number; args: string[] }[] = [];
  for (const name of await readdir('/proc'))
    if (/^\d+$/.test(name))
      try {
        const fields = (await readFile(`/proc/${name}/stat`, 'utf8'))
          .split(') ')
          .at(-1)!
          .split(' ');
        rows.push({
          pid: Number(name),
          parent: Number(fields[1]),
          args: (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').filter(Boolean),
        });
      } catch {
        /* Exited process. */
      }
  const owned = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  return rows.filter((row) => owned.has(row.pid));
}
async function gone(pids: readonly number[]) {
  await until(async () => {
    for (const pid of pids)
      try {
        const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)!.split(' ');
        if (fields[0] !== 'Z') return false;
      } catch {
        /* Already reaped. */
      }
    return true;
  }, 'Owned runtime/browser processes survived release');
}

// Explicit host integration gate. All inference is a deterministic localhost
// fixture; the installed package, Codex and existing Chrome are prerequisites.
it.skipIf(process.env.RUN_MOBILE_PLAYWRIGHT !== '1')(
  'installed Mobile runtime activates, uses and releases browser at the same-root boundary',
  async () => {
    expect(process.platform).toBe('linux');
    const manager = process.env.GESTALT_MANAGER_BIN;
    const preparedHome = process.env.GESTALT_PLAYWRIGHT_REAL_HOME;
    const fromHome = process.env.GESTALT_PLAYWRIGHT_UPGRADE_FROM_HOME;
    const chrome = process.env.GESTALT_PLAYWRIGHT_REAL_CHROME;
    expect(
      manager && preparedHome && fromHome && chrome,
      'Existing manager/package/Chrome prerequisites are required',
    ).toBeTruthy();
    const directory = await mkdtemp(join(tmpdir(), 'mobile-playwright-live-'));
    const workspace = join(directory, 'workspace'),
      home = join(directory, 'codex'),
      bin = join(directory, 'blocked-installers');
    await mkdir(workspace);
    await mkdir(home);
    await mkdir(bin);
    const blocked = join(directory, 'unexpected-installer');
    for (const name of ['npm', 'npx', 'curl', 'wget'])
      await writeFile(
        join(bin, name),
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(blocked)},${JSON.stringify(name)});process.exit(99);\n`,
        { mode: 0o700 },
      );
    const scopedPath = `${bin}:${process.env.PATH ?? ''}`;
    const preparedPackageBefore = createHash('sha256')
      .update(await readFile(join(preparedHome!, 'playwright/active.json')))
      .digest('hex');
    const preparedOldPackageBefore = createHash('sha256')
      .update(await readFile(join(fromHome!, 'playwright/active.json')))
      .digest('hex');
    const offlinePackage = await prepareOfflineUpdate({
      manager: manager!,
      preparedHome: preparedHome!,
      fromHome: fromHome!,
      directory,
      path: scopedPath,
    });
    const managed = offlinePackage.home;
    expect(offlinePackage.fromVersion).toBe('0.0.82');
    expect(offlinePackage.version).toBe('0.0.83');
    const skillPath = join(directory, 'SKILL.md');
    await writeFile(
      skillPath,
      '# Managed browser\nUse a fresh snapshot before element references. Host approvals apply.',
    );
    let packageExpected = createHash('sha256')
      .update(await readFile(join(managed!, 'playwright', 'active.json')))
      .digest('hex');
    const chromeBefore = createHash('sha256')
      .update(await readFile(chrome!))
      .digest('hex');
    const fixtureErrors: string[] = [],
      catalogs: { phase: string; browser: boolean; guidance: boolean }[] = [];
    const lifecycleResults: unknown[] = [];
    const notifications: string[] = [];
    let current: RelaySessionSnapshot;
    const snapshots = new Map<string, RelaySessionSnapshot>();
    const declarations = new Set<string>();
    const turnInputs: { phase: string; guidance: boolean }[] = [];
    let count = 0;
    let latestSnapshot = '';
    let initialMobileCookie = false;
    let initialCliEmpty = false;
    const initialHeadings: {
      phase: string;
      operation: number;
      heading: 'new' | 'returning' | 'missing';
    }[] = [];
    let savedRequests = 0;
    let returningRequests = 0;
    const page = createServer((request, response) => {
      if (request.url?.startsWith('/saved')) {
        savedRequests++;
        response.setHeader('Set-Cookie', 'mobile-proof=retained; Path=/; Max-Age=3600');
        response.end('<h1>Saved</h1>');
        return;
      }
      if (request.headers.cookie?.includes('mobile-proof=retained')) returningRequests++;
      response.end(
        `<!doctype html><title>Managed fixture</title><h1>${request.headers.cookie?.includes('mobile-proof=retained') ? 'Returning user' : 'New user'}</h1><form action="/saved"><label>Name <input name="name"></label><button>Save</button></form>`,
      );
    });
    page.listen(0, '127.0.0.1');
    await once(page, 'listening');
    const pageUrl = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
    const operations: Record<string, { tool: string; args?: Record<string, unknown> }[]> = {
      CLI_REQUEST: [{ tool: 'gestalt_managed_playwright', args: { action: 'start' } }],
      CLI_STOP: [{ tool: 'gestalt_managed_playwright', args: { action: 'stop' } }],
      CLI_OFF: [],
      REQUEST: [
        { tool: 'gestalt_managed_playwright', args: { capability: 'playwright', action: 'start' } },
      ],
      BROWSER: [
        { tool: 'browser_navigate', args: { url: pageUrl } },
        { tool: 'browser_snapshot' },
        { tool: 'browser_fill_form' },
        { tool: 'browser_snapshot' },
        { tool: 'browser_click' },
        {
          tool: 'browser_take_screenshot',
          args: { type: 'png', filename: join(workspace, 'mobile-proof.png') },
        },
        { tool: 'browser_navigate', args: { url: pageUrl } },
        { tool: 'browser_snapshot' },
      ],
      STOP: [
        { tool: 'gestalt_managed_playwright', args: { capability: 'playwright', action: 'stop' } },
      ],
      AFTER_STOP: [],
      RESTART: [{ tool: 'browser_navigate', args: { url: pageUrl } }, { tool: 'browser_snapshot' }],
      CONTENDER: [{ tool: 'browser_navigate', args: { url: pageUrl } }],
      INDEPENDENT: [
        { tool: 'browser_navigate', args: { url: pageUrl } },
        { tool: 'browser_snapshot' },
      ],
      STILL_CONNECTED: [{ tool: 'browser_snapshot' }],
      MISSING: [],
      INCOMPATIBLE: [],
      OFF: [],
    };
    operations.CLI_LOGIN = operations.BROWSER!.map((operation) =>
      operation.tool === 'browser_take_screenshot'
        ? { ...operation, args: { type: 'png', filename: join(workspace, 'cli-proof.png') } }
        : operation,
    );
    const progress = new Map<string, number>();
    const completedPhaseResults = new Map<string, string>();
    const model = createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body) as {
          tools: { name: string; type: string; tools?: WireTool[] }[];
          input: WireInput[];
        };
        // Built-in Responses tools may have a type but no function name.
        // Select only named callable tools; missing browser controls still fail below.
        const tools: WireTool[] = input.tools
          .flatMap((tool) =>
            tool.type === 'namespace'
              ? (tool.tools ?? []).map((child) => ({ ...child, namespace: tool.name }))
              : [tool],
          )
          .filter((tool) => typeof tool.name === 'string');
        const user = text(input.input.filter((item) => item.role === 'user').at(-1));
        // Like the accepted native CLI harness, distinguish auxiliary requests
        // by their absent session lifecycle control, even if they quote user text.
        // A root missing controls cannot produce the required phase marker and
        // still fails the terminal completion assertion.
        const lifecycle = tools.some((tool) => tool.name === 'gestalt_managed_playwright');
        const phase = lifecycle
          ? (Object.keys(operations).find((key) => user.includes(`PHASE_${key}`)) ?? 'AUXILIARY')
          : 'AUXILIARY';
        if (phase === 'AUXILIARY' && lifecycle) throw new Error('Unknown root local fixture phase');
        const browser = tools.some((tool) => tool.name.includes('browser_snapshot'));
        if (phase === 'AUXILIARY' && browser)
          throw new Error('Auxiliary native request exposed browser tools');
        const guidance = JSON.stringify(input.input).includes(
          'Verified managed browser tools are connected',
        );
        catalogs.push({ phase, browser, guidance });
        const index = progress.get(phase) ?? 0;
        const operation = operations[phase]?.[index];
        let item: Record<string, unknown>;
        if (operation) {
          const selected = tools.find(
            (tool) => tool.name === operation.tool || tool.name.endsWith('__' + operation.tool),
          );
          if (!selected)
            throw new Error(
              `Missing runtime tool ${operation.tool} in ${phase}/${index}; namedTools=${JSON.stringify(
                tools
                  .map((tool) => `${tool.namespace ?? ''}:${tool.name}`)
                  .sort()
                  .slice(0, 24),
              ).slice(0, 1800)}`,
            );
          const output = text(
            input.input.filter((item) => item.type === 'function_call_output').at(-1)?.output,
          );
          // Read the explicit first browser_snapshot before any form mutation.
          // Native navigation results need not contain a page snapshot.
          if (index === 2 && ['BROWSER', 'CLI_LOGIN'].includes(phase)) {
            const heading = output.includes('New user')
              ? 'new'
              : output.includes('Returning user')
                ? 'returning'
                : 'missing';
            initialHeadings.push({ phase, operation: index, heading });
            if (phase === 'BROWSER') initialMobileCookie = heading === 'returning';
            else initialCliEmpty = heading === 'new';
          }
          if (operation.tool === 'browser_snapshot') latestSnapshot = '';
          let args = operation.args ?? {};
          if (operation.tool === 'browser_fill_form') {
            const target = output.match(/textbox "Name" \[ref=(e\d+)\]/)?.[1];
            if (!target) throw new Error('Fresh textbox reference missing');
            args = {
              fields: [
                { name: 'Name', element: 'Name', type: 'textbox', target, value: 'Mobile user' },
              ],
            };
          }
          if (operation.tool === 'browser_click') {
            const target = output.match(/button "Save" \[ref=(e\d+)\]/)?.[1];
            if (!target) throw new Error('Fresh button reference missing');
            args = { element: 'Save', target };
          }
          item = {
            id: `tool_${++count}`,
            type: 'function_call',
            status: 'completed',
            name: selected.name,
            ...(selected.namespace ? { namespace: selected.namespace } : {}),
            call_id: `call_${count}`,
            arguments: JSON.stringify(args),
          };
          progress.set(phase, index + 1);
        } else {
          if (phase !== 'AUXILIARY')
            latestSnapshot = text(
              input.input.filter((item) => item.type === 'function_call_output').at(-1)?.output,
            );
          if (phase !== 'AUXILIARY') completedPhaseResults.set(phase, latestSnapshot);
          item = {
            id: `done_${++count}`,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: `${phase}_DONE`, annotations: [] }],
          };
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const events = [
          { type: 'response.created', response: { id: `response_${count}` } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: `response_${count}`,
              status: 'completed',
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
        response.end(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
        );
      } catch (error) {
        fixtureErrors.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
        response.writeHead(500).end();
      }
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    await writeFile(
      join(home, 'config.toml'),
      `model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:${(model.address() as { port: number }).port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\n[features]\ntool_search=false\ncode_mode=false\ncode_mode_only=false\n[mcp_servers.gestalt-playwright]\ncommand=${JSON.stringify(manager)}\nargs=["playwright","mcp","--executable-path",${JSON.stringify(chrome)}]\ndefault_tools_approval_mode="approve"\n`,
    );
    const missingHome = join(directory, 'codex-missing');
    await mkdir(missingHome);
    await writeFile(
      join(missingHome, 'config.toml'),
      (await readFile(join(home, 'config.toml'), 'utf8')).replace(
        JSON.stringify(chrome),
        JSON.stringify('/missing/external/chrome'),
      ),
    );
    const incompatibleChrome = join(directory, 'incompatible-chrome');
    const unexpectedChromeLaunch = join(directory, 'incompatible-chrome-launched');
    await writeFile(
      incompatibleChrome,
      `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('Google Chrome 99.0.1.2');else{require('node:fs').writeFileSync(${JSON.stringify(unexpectedChromeLaunch)},'unexpected');process.exit(99);}\n`,
      { mode: 0o700 },
    );
    const incompatibleHome = join(directory, 'codex-incompatible');
    await mkdir(incompatibleHome);
    await writeFile(
      join(incompatibleHome, 'config.toml'),
      (await readFile(join(home, 'config.toml'), 'utf8')).replace(
        JSON.stringify(chrome),
        JSON.stringify(incompatibleChrome),
      ),
    );
    const installation = new ManagedPlaywright({
      ...process.env,
      GESTALT_HOME: managed,
      GESTALT_MANAGER_BIN: manager,
      PATH: scopedPath,
    });
    const browser = new CodexPlaywright(installation);
    const authority = (session = current): PlaywrightAuthority => ({
      session,
      planIdentity: 'fixture-plan',
      activePlanId: 'browser',
      declared: declarations.has(session.id),
      fenced: false,
    });
    const processes: CodexProcess[] = [],
      exits: Promise<unknown>[] = [];
    const runtime = new CodexSessionRuntime(
      (input) => {
        const child = launchCodexAppServer({
          ...input,
          environment: {
            CODEX_HOME:
              input.profile === 'missing-chrome'
                ? missingHome
                : input.profile === 'incompatible-chrome'
                  ? incompatibleHome
                  : home,
            GESTALT_HOME: managed!,
            PATH: scopedPath,
          },
        });
        const request = child.rpc.request.bind(child.rpc);
        child.rpc.request = (method, params) => {
          if (method === 'turn/start') {
            const texts = text((params as { input: unknown }).input);
            turnInputs.push({
              phase:
                Object.keys(operations).find((key) => texts.includes(`PHASE_${key}`)) ?? 'unknown',
              guidance: texts.includes('Verified managed browser tools are connected'),
            });
          }
          return request(method, params);
        };
        processes.push(child);
        exits.push(once(child.child, 'exit'));
        return child;
      },
      undefined,
      (_id, notification) => {
        notifications.push(notification.method);
      },
      async (id, request, origin) => {
        if (!isManagedPlaywrightCall(request)) return false;
        const result = await browser.control(
          authority(snapshots.get(id) ?? current),
          (request.params as { arguments: unknown }).arguments,
          origin.kind === 'root' &&
            origin.physicalThreadId === (snapshots.get(id) ?? current).threadId,
        );
        lifecycleResults.push(result);
        return runtime.resolveServerRequest(id, String(request.id), {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
        });
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        prepare: async (session, rpc, config, deadline) => {
          const base: CodexRetrievalState = {
            ready: false,
            deadline,
            config,
            skillsConfig: [{ path: skillPath, enabled: false }],
            fallback() {},
          };
          return browser.prepare(base, authority(session), {
            rpc,
            skills: [{ name: 'gestalt:playwright', path: skillPath, enabled: false }],
            deadline: Date.now() + 10_000,
            current: () => authority(snapshots.get(session.id) ?? session),
          });
        },
        verify: (rpc, threadId, state) => browser.verify(rpc, threadId, state),
        needsResume: (session) => browser.needsResume(authority(session)),
        release: (id) => browser.release(id),
        observe: (id, notification) => browser.observe(id, notification),
        bound: (state, threadId) => browser.bound(state, threadId),
      },
    );
    async function turn(phase: string, selected = current) {
      const before = notifications.filter((method) => method === 'turn/completed').length;
      let result: RelaySessionSnapshot;
      try {
        result = await runtime.startTurn(
          selected,
          `PHASE_${phase}`,
          undefined,
          new Date().toISOString(),
        );
      } catch (error) {
        throw new Error(
          `Installed Mobile phase ${phase}, session ${selected.id}, profile ${selected.profile}`,
          { cause: error },
        );
      }
      await until(
        () =>
          fixtureErrors.length > 0 ||
          notifications.filter((method) => method === 'turn/completed').length > before,
        `Real Codex turn ${phase} did not finish`,
      );
      expect(fixtureErrors).toEqual([]);
      return result;
    }
    try {
      let cliProcesses: number[] = [];
      await seedWithNativeCli({
        manager: manager!,
        managed: managed!,
        chrome: chrome!,
        directory,
        workspace,
        modelUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
        path: scopedPath,
        failures: () => fixtureErrors,
        observe: async (pid) => {
          cliProcesses = (await processTree(pid)).map((row) => row.pid);
        },
      });
      expect(cliProcesses.length).toBeGreaterThan(0);
      await gone(cliProcesses);
      expect(
        initialCliEmpty,
        `The CLI workspace must start with no login state: ${JSON.stringify(initialHeadings)}`,
      ).toBe(true);
      expect(
        completedPhaseResults.get('CLI_LOGIN'),
        'Actual CLI must see its saved persistent login in the final browser snapshot before release',
      ).toContain('Returning user');
      expect((await stat(join(workspace, 'cli-proof.png'))).size).toBeGreaterThan(0);
      const cliSaved = savedRequests;
      // Upgrade between clients: Mobile must observe the old CLI login on the
      // new real package before it submits any form or overwrites that cookie.
      const update = await offlinePackage.update();
      expect(update).toMatchObject({
        beforeVersion: '0.0.82',
        afterVersion: '0.0.83',
        releaseChanged: true,
        actions: ['view', 'install', 'ci'],
      });
      packageExpected = createHash('sha256')
        .update(await readFile(join(managed, 'playwright/active.json')))
        .digest('hex');
      current = RelaySession.create({
        id: 'browser-session',
        workspaceId: 'fixture',
        workspacePath: workspace,
        profile: 'default',
        provider: 'codex',
        model: 'fixture',
        effectiveSkillSelection: { skills: [], capabilities: { playwright: { enabled: true } } },
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        now: new Date().toISOString(),
      }).snapshot;
      snapshots.set(current.id, current);
      current = await runtime.start(current, new Date().toISOString());
      snapshots.set(current.id, current);
      const rootThread = current.threadId;
      expect(
        (await processTree(processes.at(-1)!.child.pid!)).some((row) => row.args.includes('mcp')),
      ).toBe(false);
      await turn('REQUEST');
      expect(lifecycleResults.at(-1)).toMatchObject({ status: 'pending' });
      expect(processes).toHaveLength(1);
      const active = await turn('BROWSER');
      expect(
        initialMobileCookie,
        'Mobile must see the CLI cookie before submitting its own form',
      ).toBe(true);
      expect(active.effectiveSkillSelection?.capabilities?.playwright.enabled).toBe(true);
      expect(
        await browser.control(authority(), { capability: 'playwright', action: 'status' }, true),
      ).toMatchObject({
        status: 'connected',
        packageStatus: 'ready',
        chrome: { status: 'ready', version: expect.stringMatching(/^\d+(?:\.\d+){1,3}$/) },
        nodeStatus: 'ready',
      });
      expect(savedRequests, 'Form submission must reach the localhost cookie setter').toBe(
        cliSaved + 1,
      );
      expect(
        returningRequests,
        'Chrome must send the persistent cookie before release',
      ).toBeGreaterThan(0);
      expect(latestSnapshot, 'The live browser must see its login before release').toContain(
        'Returning user',
      );
      expect(current.threadId).toBe(rootThread);
      expect(processes).toHaveLength(2);
      expect((await stat(join(workspace, 'mobile-proof.png'))).size).toBeGreaterThan(0);
      const tree = await processTree(processes.at(-1)!.child.pid!);
      const chromeProcess = tree.find((row) => row.args.includes('--remote-debugging-pipe'));
      expect(chromeProcess, 'Real Chrome pipe was not observed').toBeTruthy();
      expect(chromeProcess!.args.some((arg) => arg.startsWith('--headless'))).toBe(true);
      expect(chromeProcess!.args).not.toContain('--no-sandbox');
      const mcp = tree.filter((row) => row.args.includes('mcp') && row.args.includes(workspace));
      expect(mcp).toHaveLength(1);
      expect(
        (await processTree(mcp[0]!.pid)).every(
          (row) => !row.args.some((arg) => /(?:^|\/)codex$/.test(arg)),
        ),
      ).toBe(true);
      const sockets = new Set<string>();
      for (const row of tree)
        try {
          for (const fd of await readdir(`/proc/${row.pid}/fd`))
            try {
              const match = (await readlink(`/proc/${row.pid}/fd/${fd}`)).match(
                /^socket:\[(\d+)\]$/,
              );
              if (match) sockets.add(match[1]!);
            } catch {
              /* Racing fd. */
            }
        } catch {
          /* Exited process. */
        }
      for (const kind of ['tcp', 'tcp6'])
        for (const line of (await readFile(`/proc/net/${kind}`, 'utf8'))
          .trim()
          .split('\n')
          .slice(1)) {
          const fields = line.trim().split(/\s+/);
          expect(fields[3] === '0A' && sockets.has(fields[9]!)).toBe(false);
        }
      async function startSecondary(id: string, path: string, profile: string) {
        let selected = RelaySession.create({
          id,
          workspaceId: id,
          workspacePath: path,
          profile,
          provider: 'codex',
          model: 'fixture',
          effectiveSkillSelection: { skills: [], capabilities: { playwright: { enabled: true } } },
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          now: new Date().toISOString(),
        }).snapshot;
        declarations.add(id);
        snapshots.set(id, selected);
        selected = await runtime.start(selected, new Date().toISOString());
        snapshots.set(id, selected);
        return selected;
      }
      const contender = await startSecondary('contender-profile', workspace, 'browser-second');
      await turn('CONTENDER', contender);
      expect(latestSnapshot).toContain('busy');
      await runtime.release(contender.id);
      const independentWorkspace = join(directory, 'independent');
      await mkdir(independentWorkspace);
      const independent = await startSecondary(
        'independent-profile',
        independentWorkspace,
        'browser-independent',
      );
      await turn('INDEPENDENT', independent);
      expect(latestSnapshot).toContain('New user');
      const independentTree = await processTree(processes.at(-1)!.child.pid!);
      expect(independentTree.some((row) => row.args.includes('--remote-debugging-pipe'))).toBe(
        true,
      );
      await turn('STILL_CONNECTED');
      expect(latestSnapshot).toContain('Returning user');
      await runtime.release(independent.id);
      await gone(independentTree.map((row) => row.pid));
      const missing = await startSecondary(
        'missing-profile',
        independentWorkspace,
        'missing-chrome',
      );
      await turn('MISSING', missing);
      expect(
        await browser.control(
          authority(missing),
          { capability: 'playwright', action: 'status' },
          true,
        ),
      ).toMatchObject({
        status: 'unavailable',
        packageStatus: 'ready',
        chrome: { status: 'unavailable', version: null },
        nodeStatus: 'ready',
      });
      expect(catalogs.filter((row) => row.phase === 'MISSING').every((row) => !row.browser)).toBe(
        true,
      );
      await runtime.release(missing.id);
      const incompatible = await startSecondary(
        'incompatible-profile',
        independentWorkspace,
        'incompatible-chrome',
      );
      await turn('INCOMPATIBLE', incompatible);
      expect(
        await browser.control(
          authority(incompatible),
          { capability: 'playwright', action: 'status' },
          true,
        ),
      ).toMatchObject({ status: 'unavailable', chrome: { status: 'unavailable' } });
      expect(
        catalogs.filter((row) => row.phase === 'INCOMPATIBLE').every((row) => !row.browser),
      ).toBe(true);
      await expect(stat(unexpectedChromeLaunch)).rejects.toMatchObject({ code: 'ENOENT' });
      await runtime.release(incompatible.id);
      await turn('STOP');
      expect(lifecycleResults.at(-1)).toMatchObject({ status: 'pending' });
      await turn('AFTER_STOP');
      await gone(tree.map((row) => row.pid));
      expect(
        catalogs.filter((row) => row.phase === 'AFTER_STOP').every((row) => !row.browser),
      ).toBe(true);
      expect(
        turnInputs.filter((row) => row.phase === 'AFTER_STOP').every((row) => !row.guidance),
      ).toBe(true);
      expect(
        await browser.control(authority(), { capability: 'playwright', action: 'status' }, true),
      ).toMatchObject({ status: 'idle' });
      await browser.control(authority(), { capability: 'playwright', action: 'start' }, true);
      await turn('RESTART');
      expect(latestSnapshot).toContain('Returning user');
      const runtimeStatus = await browser.control(
        authority(),
        { capability: 'playwright', action: 'status' },
        true,
      );
      const restarted = await processTree(processes.at(-1)!.child.pid!);
      current = {
        ...current,
        effectiveSkillSelection: {
          ...current.effectiveSkillSelection!,
          capabilities: { playwright: { enabled: false } },
        },
      };
      snapshots.set(current.id, current);
      await turn('OFF');
      await gone(restarted.map((row) => row.pid));
      expect(catalogs.filter((row) => row.phase === 'OFF').every((row) => !row.browser)).toBe(true);
      expect(turnInputs.filter((row) => row.phase === 'OFF').every((row) => !row.guidance)).toBe(
        true,
      );
      expect(
        createHash('sha256')
          .update(await readFile(join(managed!, 'playwright', 'active.json')))
          .digest('hex'),
      ).toBe(packageExpected);
      expect(
        createHash('sha256')
          .update(await readFile(join(preparedHome!, 'playwright/active.json')))
          .digest('hex'),
      ).toBe(preparedPackageBefore);
      expect(
        createHash('sha256')
          .update(await readFile(join(fromHome!, 'playwright/active.json')))
          .digest('hex'),
      ).toBe(preparedOldPackageBefore);
      expect(
        createHash('sha256')
          .update(await readFile(chrome!))
          .digest('hex'),
      ).toBe(chromeBefore);
      await expect(stat(blocked)).rejects.toMatchObject({ code: 'ENOENT' });
      if (process.env.PLAYWRIGHT_EVIDENCE_DIR) {
        await mkdir(process.env.PLAYWRIGHT_EVIDENCE_DIR, { recursive: true });
        await copyFile(
          join(workspace, 'mobile-proof.png'),
          join(process.env.PLAYWRIGHT_EVIDENCE_DIR, 'mobile-browser-proof.png'),
        );
        await copyFile(
          join(workspace, 'cli-proof.png'),
          join(process.env.PLAYWRIGHT_EVIDENCE_DIR, 'cli-browser-proof.png'),
        );
        await writeFile(
          join(process.env.PLAYWRIGHT_EVIDENCE_DIR, 'runtime-evidence.json'),
          JSON.stringify(
            {
              nodeVersion: process.version,
              packageVersion: offlinePackage.version,
              chrome: 'chrome' in runtimeStatus ? runtimeStatus.chrome : null,
              packageUpdate: update,
              sameWorkspaceCookie: true,
              separateWorkspaceEmpty: true,
              contentionBounded: true,
              absentChromeChat: true,
              incompatibleVersionProbeChat: true,
              noBootInstallers: true,
              headless: true,
              transport: 'stdio',
              browserTransport: 'pipe',
              ownedTcpListeners: 0,
            },
            null,
            2,
          ) + '\n',
        );
      }
      await runtime.release(current.id);
      await Promise.all(exits);
    } finally {
      runtime.stopAll();
      await Promise.all(exits);
      page.closeAllConnections();
      model.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => page.close(() => resolve())),
        new Promise<void>((resolve) => model.close(() => resolve())),
      ]);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
