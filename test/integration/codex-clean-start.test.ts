/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { launchCodexAppServer } from '../../src/server/platform/codex/codex-process-launcher.js';
import { CodexSessionRuntime } from '../../src/server/platform/codex/session-runtime.js';
import { RelaySession } from '../../src/server/features/sessions/model/relay-session.js';

// Explicit opt-in: exercises the installed binary with a local deterministic Responses server.
// No account, production CODEX_HOME, user database, or remote inference is used.
it.skipIf(process.env.RUN_INSTALLED_CODEX !== '1')(
  'clean start and resume expose native projection and Mobile health on installed Codex',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mobile-codex-contract-'));
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      if (!request.url?.endsWith('/responses')) {
        response.writeHead(404).end();
        return;
      }
      requests.push(JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const item =
        requests.length % 2 === 1
          ? {
              type: 'custom_tool_call',
              id: `exec_${requests.length}`,
              call_id: `call_${requests.length}`,
              name: 'exec',
              input:
                'text(await tools.update_plan({plan:[{step:"Fixture projection",status:"completed"}]})); text(await tools.gestalt_org_plan_health({}));',
            }
          : {
              type: 'message',
              id: 'msg_fixture',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Fixture complete.', annotations: [] }],
            };
      const events = [
        { type: 'response.created', response: { id: 'resp_fixture' } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'resp_fixture',
            status: 'completed',
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      response.end(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    await writeFile(
      join(directory, 'config.toml'),
      `model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\n[features]\ncode_mode = true\ncode_mode_only = true\n`,
    );
    const notifications: string[] = [];
    const exits: Promise<unknown>[] = [];
    let healthReads = 0;
    const runtime = new CodexSessionRuntime(
      (input) => {
        const process = launchCodexAppServer({ ...input, environment: { CODEX_HOME: directory } });
        exits.push(once(process.child, 'exit'));
        return process;
      },
      undefined,
      (_id, notification) => {
        notifications.push(notification.method);
      },
      (id, request) => {
        const params = request.params as { tool?: string };
        if (params.tool !== 'gestalt_org_plan_health') return false;
        healthReads++;
        return runtime.resolveServerRequest(id, String(request.id), {
          success: true,
          contentItems: [{ type: 'inputText', text: '{"health":{"phase":"off"}}' }],
        });
      },
    );
    try {
      const session = RelaySession.create({
        id: 'isolated',
        workspaceId: 'fixture',
        workspacePath: directory,
        effectiveSkillSelection: { skills: [] },
        profile: 'default',
        provider: 'codex',
        model: 'gpt-5.4',
        now: new Date().toISOString(),
      }).snapshot;
      const started = await runtime.start(session, new Date().toISOString());
      expect(await runtime.readActivity(started)).toEqual({ active: false });
      await runtime.startTurn(started, 'Contract fixture.', undefined, new Date().toISOString());
      await waitUntil(() => notifications.includes('turn/completed'));
      expect(notifications).toContain('turn/plan/updated');
      runtime.stopAll();
      await Promise.all(exits);
      notifications.length = 0;
      await runtime.restore(started, new Date().toISOString());
      expect(await runtime.readActivity(started)).toEqual({ active: false });
      await runtime.startTurn(
        started,
        'Resume contract fixture.',
        undefined,
        new Date().toISOString(),
      );
      await waitUntil(() => notifications.includes('turn/completed'));
      expect(notifications).toContain('turn/plan/updated');
      expect(requests).toHaveLength(4);
      expect(healthReads).toBe(2);
      for (const request of requests) {
        const tools = JSON.stringify(request.tools);
        expect(tools).toContain('update_plan');
        expect(tools).toContain('gestalt_org_plan_health');
      }
    } finally {
      runtime.stopAll();
      await Promise.all(exits);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('CODEX_CONTRACT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
