/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawnSync } from 'node:child_process';

const shardCount = 4;
const config = 'playwright.functional.config.ts';

function list(shard) {
  const args = ['playwright', 'test', '--config', config, '--list', '--reporter=list'];
  if (shard) args.push(`--shard=${shard}/${shardCount}`);
  const result = spawnSync('npx', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('  ') && line.includes(' › '))
    .map((line) => line.trim());
}

const complete = list();
const completeSet = new Set(complete);
const sharded = Array.from({ length: shardCount }, (_, index) => list(index + 1));
const flattened = sharded.flat();
const duplicates = flattened.filter((test, index) => flattened.indexOf(test) !== index);
const shardSet = new Set(flattened);
const missing = complete.filter((test) => !shardSet.has(test));
const unexpected = flattened.filter((test) => !completeSet.has(test));

if (
  duplicates.length ||
  missing.length ||
  unexpected.length ||
  shardSet.size !== completeSet.size
) {
  throw new Error(
    JSON.stringify({
      complete: completeSet.size,
      sharded: shardSet.size,
      duplicates,
      missing,
      unexpected,
    }),
  );
}

console.log(
  JSON.stringify({
    tests: completeSet.size,
    shardCounts: sharded.map((tests) => tests.length),
    shardCount,
  }),
);
