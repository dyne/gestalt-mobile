/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const serverRoot = resolve(import.meta.dirname);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function runtimeImports(path: string): string[] {
  return [
    ...readFileSync(path, 'utf8').matchAll(
      /^import (?!type\b)[\s\S]*? from ['"](\.[^'"]+)['"];?$/gm,
    ),
  ]
    .map((match) => match[1])
    .map((specifier) => resolve(dirname(path), specifier.replace(/\.js$/, '.ts')))
    .filter((target) => extname(target) === '.ts');
}

/** Extract static, side-effect, dynamic, and CommonJS-style import specifiers. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bimport\s+(?:[^'"()]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:require|createRequire)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]!));
}

const forbiddenActivityAdapter =
  /^(?:fastify(?:\/|$)|node:(?:fs|timers)(?:\/|$)|.*(?:platform\/codex|platform\/persistence|sqlite|\.svelte)(?:\/|$)?)/;

function hasCycle(
  path: string,
  graph: ReadonlyMap<string, readonly string[]>,
  visiting = new Set<string>(),
  visited = new Set<string>(),
): boolean {
  if (visiting.has(path)) return true;
  if (visited.has(path)) return false;
  visiting.add(path);
  const cycle = (graph.get(path) ?? []).some(
    (target) => graph.has(target) && hasCycle(target, graph, visiting, visited),
  );
  visiting.delete(path);
  visited.add(path);
  return cycle;
}

describe('server production architecture', () => {
  it('keeps runtime imports acyclic', () => {
    const files = sourceFiles(serverRoot);
    const graph = new Map(files.map((path) => [path, runtimeImports(path)]));

    expect(files.some((path) => hasCycle(path, graph))).toBe(false);
  });
  it('keeps agent-activity domain free of framework, persistence, and Codex adapters', () => {
    const root = join(serverRoot, 'features', 'agent-activity');
    for (const path of sourceFiles(root)) {
      const source = readFileSync(path, 'utf8');
      expect(
        importSpecifiers(source).some((specifier) => forbiddenActivityAdapter.test(specifier)),
      ).toBe(false);
    }
  });
  it('keeps the Org Plan attention feature behind ports rather than Codex or persistence adapters', () => {
    const root = join(serverRoot, 'features', 'org-plan-attention', 'application');
    for (const path of sourceFiles(root)) {
      const source = readFileSync(path, 'utf8');
      expect(
        importSpecifiers(source).some((specifier) => forbiddenActivityAdapter.test(specifier)),
      ).toBe(false);
    }
  });
  it('keeps autopilot application and domain independent of framework, Codex, persistence, and timers', () => {
    const root = join(serverRoot, 'features', 'autopilot');
    for (const path of sourceFiles(root).filter(
      (path) => path.includes('/application/') || path.includes('/domain/'),
    )) {
      const source = readFileSync(path, 'utf8');
      expect(
        importSpecifiers(source).some((specifier) => forbiddenActivityAdapter.test(specifier)),
      ).toBe(false);
    }
  });
  it('recognizes forbidden imports in static, side-effect, dynamic, and require forms', () => {
    expect(
      importSpecifiers(`
        import Fastify from 'fastify';
        import 'node:fs';
        void import('../platform/codex/session-runtime.js');
        require('../platform/persistence/sqlite.js');
        createRequire('widget.svelte');
      `).every((specifier) => forbiddenActivityAdapter.test(specifier)),
    ).toBe(true);
  });
});
