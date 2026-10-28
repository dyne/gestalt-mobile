/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(description);
    await pause(25);
  }
}

async function execute(args: readonly string[], environment: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn('codex', [...args], {
    cwd,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output = (output + data).slice(-2048);
  });
  child.stderr.on('data', (data) => {
    output = (output + data).slice(-2048);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    if (code !== 0)
      throw new Error(`Local native plugin fixture setup failed (${code}): ${output}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Same actual native-TUI/bootstrap harness as the accepted manager L3 tests.
 * Extract production launch_cli_with_xerj verbatim; only add bounded lifecycle
 * observation. This avoids global manager/setup mutations and uses no npm,
 * browser/package install, network model, or replacement MCP implementation.
 */
export async function seedWithNativeCli(input: {
  manager: string;
  managed: string;
  chrome: string;
  directory: string;
  workspace: string;
  modelUrl: string;
  path: string;
  failures(): readonly string[];
  observe?(pid: number): Promise<void>;
}) {
  const home = join(input.directory, 'native-cli-home');
  await mkdir(home);
  const marketplace = join(input.directory, 'local-native-marketplace');
  const plugin = join(marketplace, 'plugins/gestalt');
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(join(plugin, 'skills/playwright'), { recursive: true });
  await mkdir(join(marketplace, '.agents/plugins'), { recursive: true });
  await writeFile(
    join(plugin, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: 'gestalt',
      version: '0.0.1',
      description: 'Local managed-browser integration fixture',
      skills: './skills/',
    }),
  );
  await writeFile(
    join(plugin, 'skills/playwright/SKILL.md'),
    '---\nname: playwright\ndescription: Host-owned browser fixture.\n---\nUse fresh snapshots. Host approvals apply.\n',
  );
  await writeFile(
    join(marketplace, '.agents/plugins/marketplace.json'),
    JSON.stringify({
      name: 'mobile-browser-fixture',
      plugins: [{ name: 'gestalt', source: { source: 'local', path: './plugins/gestalt' } }],
    }),
  );
  const environment = {
    ...process.env,
    CODEX_HOME: home,
    GESTALT_HOME: input.managed,
    GESTALT_MANAGER_BIN: input.manager,
    TERM: 'xterm-256color',
    PATH: input.path,
  };
  for (const key of Object.keys(environment))
    if (
      key.startsWith('CONTEXT_MODE_') ||
      key.startsWith('GESTALT_MOBILE_') ||
      key.startsWith('GESTALT_ORG_PLAN_')
    )
      delete (environment as NodeJS.ProcessEnv)[key];
  // Registers only the above local fixture inside this disposable CODEX_HOME.
  await execute(['plugin', 'marketplace', 'add', marketplace], environment, input.workspace);
  await execute(['plugin', 'add', 'gestalt@mobile-browser-fixture'], environment, input.workspace);
  await writeFile(
    join(home, 'config.toml'),
    `model="fixture"\nmodel_provider="fixture"\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[projects.${JSON.stringify(input.workspace)}]\ntrust_level="trusted"\n[model_providers.fixture]\nname="fixture"\nbase_url=${JSON.stringify(input.modelUrl)}\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\n[features]\ntool_search=false\nhooks=false\ncode_mode=false\ncode_mode_only=false\n[tui]\nscreen_reader_detection_done=true\n[tui.model_availability_nux]\n"gpt-6.1-sol"=1\n[plugins."gestalt@mobile-browser-fixture"]\nenabled=true\n`,
  );
  await writeFile(
    join(home, 'browser.config.toml'),
    `[mcp_servers.gestalt-playwright]\nenabled=true\ndefault_tools_approval_mode="approve"\nargs=["playwright","mcp","--executable-path",${JSON.stringify(input.chrome)}]\n`,
  );
  const source = await readFile(input.manager, 'utf8');
  const program = source
    .split('launch_cli_with_xerj() {')[1]
    ?.split("<<'NODE'\n")[1]
    ?.split('\nNODE\n')[0];
  const needle = 'managedPlaywright(launchArgs, undefined, refreshPlaywrightConsent)';
  if (!program?.includes(needle))
    throw new Error(
      'Accepted manager native bootstrap is incompatible with integration observation',
    );
  const eventsPath = join(input.directory, 'native-cli-lifecycle.jsonl');
  const adapter = join(input.directory, 'native-cli-bootstrap.mjs');
  await writeFile(
    adapter,
    `import {appendFileSync as writeFixtureDiagnostic} from 'node:fs';\nconst fixtureDiagnostic=(stage,error)=>writeFixtureDiagnostic(${JSON.stringify(eventsPath)},JSON.stringify({stage,message:error.message,cause:error.cause})+'\\n');\n` +
      program.replace(
        needle,
        'managedPlaywright(launchArgs, fixtureDiagnostic, refreshPlaywrightConsent)',
      ),
  );
  const args = [process.execPath, adapter, '-pbrowser', '--no-alt-screen', 'PHASE_CLI_REQUEST'];
  const terminal = spawn(
    'script',
    ['-qefc', `stty rows 30 cols 100; exec ${args.map(quote).join(' ')} 3<&0`, '/dev/null'],
    { cwd: input.workspace, env: environment, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '',
    stderr = '';
  terminal.stdout.on('data', (chunk) => {
    const value = chunk.toString();
    output = (output + value).slice(-100_000);
    if (value.includes('\x1b[6n')) terminal.stdin.write('\x1b[1;1R');
    if (value.includes('\x1b[c') || value.includes('\x1b[>c')) terminal.stdin.write('\x1b[?1;2c');
  });
  terminal.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2048);
  });
  const events = async () => {
    try {
      return (await readFile(eventsPath, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { stage: string; message?: string; cause?: { threadId?: string } },
        );
    } catch {
      return [];
    }
  };
  const submit = async (prompt: string) => {
    const before = output.length;
    terminal.stdin.write('\x1b[200~' + prompt + '\x1b[201~');
    await until(
      () => output.slice(before).includes(prompt) || terminal.exitCode !== null,
      'Native CLI composer did not render input',
    );
    if (terminal.exitCode !== null)
      throw new Error('Native CLI exited before submission: ' + stderr + output.slice(-1000));
    terminal.stdin.write('\r');
  };
  try {
    let completed = 0;
    for (const phase of ['CLI_REQUEST', 'CLI_LOGIN', 'CLI_STOP', 'CLI_OFF']) {
      await until(
        () =>
          output.includes(`${phase}_DONE`) ||
          terminal.exitCode !== null ||
          input.failures().length > 0,
        `Native CLI phase ${phase} did not finish: ${stderr}`,
      );
      if (input.failures().length) throw new Error(input.failures().join('\n'));
      if (terminal.exitCode !== null)
        throw new Error(`Native CLI exited during ${phase}: ${stderr}${output.slice(-1200)}`);
      completed++;
      await until(async () => {
        const rows = await events();
        const root = rows.find(
          (row) =>
            ['runtime:thread/start', 'runtime:thread/resume'].includes(row.stage) &&
            row.message === 'persistent',
        )?.cause?.threadId;
        return (
          rows.filter(
            (row) => row.stage === 'runtime:turn/completed' && row.cause?.threadId === root,
          ).length >= completed
        );
      }, `Native CLI ${phase} completion was not observed`);
      if (phase === 'CLI_LOGIN' && terminal.pid) await input.observe?.(terminal.pid);
      if (phase !== 'CLI_OFF')
        await submit(
          'PHASE_' +
            (
              { CLI_REQUEST: 'CLI_LOGIN', CLI_LOGIN: 'CLI_STOP', CLI_STOP: 'CLI_OFF' } as Record<
                string,
                string
              >
            )[phase],
        );
    }
    await submit('/exit');
    await until(() => terminal.exitCode !== null, 'Native CLI did not exit');
    if (terminal.exitCode !== 0)
      throw new Error(`Native CLI failed (${terminal.exitCode}): ${stderr}`);
    const rows = await events();
    const starts = rows.filter(
      (row) =>
        ['runtime:thread/start', 'runtime:thread/resume'].includes(row.stage) &&
        row.message === 'persistent',
    );
    const roots = new Set(starts.map((row) => row.cause?.threadId));
    if (roots.size !== 1 || roots.has(undefined))
      throw new Error('Native CLI activation/release changed its root identity');
  } finally {
    if (terminal.exitCode === null && terminal.signalCode === null) {
      terminal.kill('SIGTERM');
      const timer = setTimeout(() => terminal.kill('SIGKILL'), 2000);
      await new Promise<void>((resolve) => terminal.once('exit', () => resolve()));
      clearTimeout(timer);
    }
  }
}
