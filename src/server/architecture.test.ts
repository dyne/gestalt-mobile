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
});
