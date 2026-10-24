/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseSupervisedPlan } from './parse-supervised-plan.js';
import { SupervisedPlanRegistry } from './supervised-plan-registry.js';
import {
  FilesystemPlanStatusSource,
  planStatusFilePath,
} from '../../../platform/plans/filesystem-plan-status-source.js';
import { ORG_PLAN_CAPABILITIES } from '../../../platform/plans/org-plan-capabilities.js';

const policy = `:MODEL: gpt-6-luna
:REASONING_EFFORT: medium
:MODEL_RATIONALE: Mechanical edit with clear acceptance checks; all rubric axes zero.
:MODEL_FALLBACKS: gpt-6-sol gpt-6.1-sol
:MODEL_ESCALATION_TRIGGER: A focused correctness regression remains unresolved.
`;
const header =
  '#+TITLE: Policy fixture\n#+SUBTITLE: Synthetic\n#+DATE: 2026-10-21\n#+KEYWORDS: fixture\n';
function l1(id: string, state = 'WIP', review = 'UNREVIEWED', fields = policy) {
  return `* ${state} [#A] ${id}\n:PROPERTIES:\n:ID: ${id}\n:SKILLS: $nodejs-backend-patterns\n:REVIEW_STATUS: ${review}\n${fields}:END:\n- Effort :: Small\n- Goal :: Retain policy\n- Notes :: Synthetic contract\n`;
}
const source = () => header + '#+MODEL_POLICY_VERSION: 1\n' + l1('first');
const parse = (text: string) =>
  parseSupervisedPlan({ source: text, planPath: '/work/plan.org', workspacePath: '/work' });
const necessity = `:EFFORT_NECESSITY_KIND: unresolved-correctness
:EFFORT_NECESSITY: A specific invariant remains unresolved at medium.
:EFFORT_EVIDENCE: Synthetic focused failing case.
:EFFORT_SCOPE: One invariant.
:RETURN_TO_MEDIUM: Invariant resolved and regression passes.
`;

describe('L1 model-policy-v1 retention', () => {
  it('retains explicit assurance without changing requested policy; existing v1 needs no rewrite', () => {
    for (const assurance of ['configured', 'runtime-attested']) {
      expect(
        parse(
          source().replace(
            '#+MODEL_POLICY_VERSION: 1',
            `#+MODEL_POLICY_VERSION: 1\n#+MODEL_POLICY_ASSURANCE: ${assurance}`,
          ),
        ),
      ).toMatchObject({
        kind: 'available',
        plan: { modelPolicyAssurance: assurance },
      });
    }
    expect(parse(source())).not.toHaveProperty('plan.modelPolicyAssurance');
  });
  it.each([
    '#+MODEL_POLICY_ASSURANCE: strict',
    '#+MODEL_POLICY_ASSURANCE: configured\n#+MODEL_POLICY_ASSURANCE: runtime-attested',
    '#+MODEL_POLICY_ASSURANCE: ',
  ])('rejects invalid assurance %s', (declaration) => {
    expect(parse(declaration + '\n' + source()).kind).toBe('unavailable');
  });
  it('rejects assurance without version, after headings or in a drawer', () => {
    expect(
      parse(
        '#+MODEL_POLICY_ASSURANCE: configured\n' + header + l1('first', 'WIP', 'UNREVIEWED', ''),
      ).kind,
    ).toBe('unavailable');
    expect(parse(source() + '#+MODEL_POLICY_ASSURANCE: configured\n').kind).toBe('unavailable');
    expect(
      parse(source().replace(':ID: first', ':ID: first\n:MODEL_POLICY_ASSURANCE: configured')).kind,
    ).toBe('unavailable');
  });
  it('retains complete immutable values without inventing effective settings; legacy stays absent', () => {
    const result = parse(source());
    expect(result).toMatchObject({
      kind: 'available',
      plan: {
        modelPolicyVersion: 1,
        steps: [
          {
            modelPolicy: {
              version: 1,
              model: 'gpt-6-luna',
              reasoningEffort: 'medium',
              rationale: 'Mechanical edit with clear acceptance checks; all rubric axes zero.',
              allowedFallbacks: ['gpt-6-sol', 'gpt-6.1-sol'],
              escalationTrigger: 'A focused correctness regression remains unresolved.',
              necessity: null,
            },
          },
        ],
      },
    });
    if (result.kind !== 'available') throw new Error('fixture invalid');
    const retained = result.plan.steps[0]!.modelPolicy!;
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.allowedFallbacks)).toBe(true);
    expect(retained).not.toHaveProperty('effectiveModel');
    const legacy = parse(header + l1('first', 'WIP', 'UNREVIEWED', ''));
    expect(legacy.kind).toBe('available');
    expect(legacy).not.toHaveProperty('plan.modelPolicyVersion');
    expect(legacy).not.toHaveProperty('plan.steps.0.modelPolicy');
  });

  it.each(['gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol'])(
    'accepts exact %s with none fallbacks',
    (model) => {
      expect(
        parse(source().replace('gpt-6-luna', model).replace('gpt-6-sol gpt-6.1-sol', 'none')).kind,
      ).toBe('available');
    },
  );

  it.each(['high', 'xhigh'])('retains justified %s and its full necessity', (effort) => {
    const text = source().replace(
      ':REASONING_EFFORT: medium',
      `:REASONING_EFFORT: ${effort}\n${necessity}${effort === 'xhigh' ? ':SCOPE_REASSESSMENT: Narrow invariant scope reviewed.\n' : ''}`.trimEnd(),
    );
    const result = parse(text);
    expect(result.kind).toBe('available');
    if (result.kind !== 'available') return;
    expect(result.plan.steps[0]!.modelPolicy?.necessity).toMatchObject({
      kind: 'unresolved-correctness',
      affectedScope: 'One invariant.',
    });
    expect(Object.isFrozen(result.plan.steps[0]!.modelPolicy?.necessity)).toBe(true);
  });

  it.each([
    'EFFORT_NECESSITY_KIND',
    'EFFORT_NECESSITY',
    'EFFORT_EVIDENCE',
    'EFFORT_SCOPE',
    'RETURN_TO_MEDIUM',
    'SCOPE_REASSESSMENT',
  ])('rejects xhigh without %s', (key) => {
    const text = source().replace(
      ':REASONING_EFFORT: medium',
      `:REASONING_EFFORT: xhigh\n${necessity}:SCOPE_REASSESSMENT: Reassessed.`,
    );
    expect(parse(text.replace(new RegExp(`^:${key}:.*\\n`, 'm'), '')).kind).toBe('unavailable');
  });

  it.each([
    ['unknown version', (s: string) => s.replace('VERSION: 1', 'VERSION: 2')],
    ['malformed version', (s: string) => s.replace('VERSION: 1', 'VERSION: 01')],
    ['duplicate version', (s: string) => '#+MODEL_POLICY_VERSION: 1\n' + s],
    [
      'misplaced version',
      (s: string) => s.replace('#+MODEL_POLICY_VERSION: 1\n', '') + '#+MODEL_POLICY_VERSION: 1\n',
    ],
    ['unversioned properties', (s: string) => s.replace('#+MODEL_POLICY_VERSION: 1\n', '')],
    [
      'drawer version',
      (s: string) => s.replace(':ID: first', ':ID: first\n:MODEL_POLICY_VERSION: 1'),
    ],
    ['Astra', (s: string) => s.replace('gpt-6-luna', 'gpt-6-astra')],
    ['alias', (s: string) => s.replace('gpt-6-luna', 'gpt-6')],
    ['unsupported effort', (s: string) => s.replace('EFFORT: medium', 'EFFORT: low')],
    ['unjustified high', (s: string) => s.replace('EFFORT: medium', 'EFFORT: high')],
    ['medium exception', (s: string) => s.replace(':MODEL:', necessity + ':MODEL:')],
    [
      'fallback alias',
      (s: string) => s.replace('FALLBACKS: gpt-6-sol gpt-6.1-sol', 'FALLBACKS: auto'),
    ],
    [
      'fallback repeats selected',
      (s: string) => s.replace('FALLBACKS: gpt-6-sol', 'FALLBACKS: gpt-6-luna'),
    ],
    [
      'duplicate fallback',
      (s: string) => s.replace('gpt-6-sol gpt-6.1-sol', 'gpt-6-sol gpt-6-sol'),
    ],
    [
      'fallback whitespace',
      (s: string) => s.replace('gpt-6-sol gpt-6.1-sol', 'gpt-6-sol  gpt-6.1-sol'),
    ],
    [
      'oversize UTF8',
      (s: string) =>
        s.replace(
          'Mechanical edit with clear acceptance checks; all rubric axes zero.',
          'é'.repeat(513),
        ),
    ],
    ['missing later L1 policy', (s: string) => s + l1('second', 'TODO', 'UNREVIEWED', '')],
    [
      'child override',
      (s: string) =>
        s +
        '** TODO [#A] Child\n:PROPERTIES:\n:ID: child\n' +
        policy +
        ':END:\n- Why :: x\n- Change :: x\n- Tests :: x\n- Done when :: x\n',
    ],
  ])('rejects %s without a partial projection', (_name, change) => {
    expect(parse(change(source()))).toEqual({
      kind: 'unavailable',
      reason: 'INVALID_MODEL_POLICY',
    });
  });

  it.each([
    'MODEL',
    'REASONING_EFFORT',
    'MODEL_RATIONALE',
    'MODEL_FALLBACKS',
    'MODEL_ESCALATION_TRIGGER',
  ])('requires exactly one nonempty %s', (key) => {
    for (const replacement of ['', `:${key}:\n`])
      expect(parse(source().replace(new RegExp(`^:${key}:.*\\n`, 'm'), replacement)).kind).toBe(
        'unavailable',
      );
    expect(parse(source().replace(':END:', `:${key}: duplicate\n:END:`)).kind).toBe('unavailable');
  });

  it('accepts the exact UTF8 value boundary and preserves the full rationale', () => {
    const text = source().replace(
      'Mechanical edit with clear acceptance checks; all rubric axes zero.',
      'é'.repeat(512),
    );
    const result = parse(text);
    expect(result.kind).toBe('available');
    if (result.kind === 'available')
      expect(result.plan.steps[0]!.modelPolicy!.rationale).toHaveLength(512);
  });
});

async function withPublication(
  run: (input: {
    root: string;
    path: string;
    source: FilesystemPlanStatusSource;
    registry: SupervisedPlanRegistry;
    session: { id: string; workspacePath: string };
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'mobile-model-policy-'));
  const status = new FilesystemPlanStatusSource(join(root, 'state'));
  try {
    const path = join(root, 'plan.org');
    await writeFile(path, source());
    await run({
      root,
      path,
      source: status,
      registry: new SupervisedPlanRegistry(),
      session: { id: 'session', workspacePath: root },
    });
  } finally {
    status.closeAll();
    await rm(root, { recursive: true, force: true });
  }
}

describe('policy publication and registry recovery', () => {
  it('preserves policy through attachment and a fresh source/registry restart', async () => {
    await withPublication(async ({ root, path, source: status, registry, session }) => {
      await status.attach(session, path, (update) => registry.accept(session.id, update));
      const before = registry.find(session.id);
      expect(before?.modelPolicyVersion).toBe(1);
      const lease = await status.open(session, () => {});
      expect(
        JSON.parse(await readFile(planStatusFilePath(lease.statusDirectory, path), 'utf8')),
      ).toMatchObject({ modelPolicyVersion: 1, requiredCapabilities: ['l1-model-policy-v1'] });
      status.closeAll();
      const restarted = new FilesystemPlanStatusSource(join(root, 'state'));
      const recovered = new SupervisedPlanRegistry();
      try {
        await restarted.open(session, (update) => recovered.accept(session.id, update));
        expect(recovered.find(session.id)).toEqual(before);
      } finally {
        restarted.closeAll();
      }
    });
  });

  it.each([
    {},
    { modelPolicyVersion: 2, requiredCapabilities: ['l1-model-policy-v1'] },
    { modelPolicyVersion: 1 },
    { modelPolicyVersion: 1, requiredCapabilities: [] },
    { modelPolicyVersion: 1, requiredCapabilities: ['l1-model-policy-v1', 'future-capability'] },
    { modelPolicyVersion: 1, requiredCapabilities: 'l1-model-policy-v1' },
  ])('refuses incompatible versioned publication %j', async (metadata) => {
    await withPublication(async ({ path, source: status, session }) => {
      const updates: unknown[] = [];
      const lease = await status.open(session, (update) => updates.push(update));
      await writeFile(
        planStatusFilePath(lease.statusDirectory, path),
        JSON.stringify({
          schemaVersion: 1,
          planPath: path,
          reason: 'resync',
          updatedAt: '2026-10-21T00:00:00Z',
          ...metadata,
        }),
      );
      await status.refresh(session.id);
      expect(updates).not.toContainEqual(expect.objectContaining({ kind: 'updated' }));
    });
  });

  const helper = process.env.GESTALT_TEST_ORG_PLAN_HELPER;
  if (helper)
    it('consumes actual Agents publication, negotiation and suspend/reopen/resume without policy loss', async () => {
      await withPublication(async ({ root, path, source: status, registry, session }) => {
        const original =
          header +
          '#+MODEL_POLICY_VERSION: 1\n' +
          l1('dependency', 'DONE', 'REVIEWED') +
          l1('active');
        await writeFile(path, original);
        const lease = await status.open(session, (update) => registry.accept(session.id, update));
        const run = (capabilities: string, ...args: string[]) =>
          promisify(execFile)(helper, [args[0]!, path, ...args.slice(1)], {
            env: {
              PATH: process.env.PATH,
              GESTALT_MOBILE_ORG_PLAN_STATUS_DIRECTORY: lease.statusDirectory,
              GESTALT_MOBILE_ORG_PLAN_CAPABILITIES: capabilities,
            },
            timeout: 15000,
          });
        await expect(run('suspension-v1', 'signal', 'resync')).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe(original);
        await run(ORG_PLAN_CAPABILITIES, 'signal', 'resync');
        await status.refresh(session.id);
        const policies = registry.find(session.id)!.steps.map((step) => step.modelPolicy);
        for (const args of [
          ['suspend-reopen', 'active', 'dependency'],
          ['set', 'dependency', 'DONE'],
          ['review', 'dependency', 'REVIEWED'],
          ['resume', 'active'],
        ]) {
          await run(ORG_PLAN_CAPABILITIES, ...args);
          await status.refresh(session.id);
          expect(registry.find(session.id)!.steps.map((step) => step.modelPolicy)).toEqual(
            policies,
          );
        }
        expect(registry.find(session.id)?.steps[1]?.state).toBe('WIP');
        expect(await readFile(path, 'utf8')).toBe(original);
        expect(root).toBe(session.workspacePath);
      });
    }, 30000);
});
