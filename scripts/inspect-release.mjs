#!/usr/bin/env node

/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { decideBootstrap, decideTarget } from './release-policy.mjs';

const [phase, target] = process.argv.slice(2);
const headSha = requiredEnvironment('GITHUB_SHA');
const repository = requiredEnvironment('GITHUB_REPOSITORY');
const outputPath = requiredEnvironment('GITHUB_OUTPUT');

if (phase === 'bootstrap') {
  const remoteTags = readRemoteTags();
  const npmVersions = npmJson(['view', 'gestalt-mobile', 'versions', '--json']) ?? [];
  const publication = npmVersions.includes('0.1.0') ? readPublication('0.1.0') : null;
  const decision = decideBootstrap({
    remoteTags: [...remoteTags.keys()],
    npmVersions: Array.isArray(npmVersions) ? npmVersions : [npmVersions],
    npmPublication: publication,
    headSha,
  });
  writeDecision(decision);
} else if (phase === 'target' && target) {
  const remoteTags = readRemoteTags();
  const decision = decideTarget({
    target,
    headSha,
    npmPublication: readPublication(target),
    tagSha: remoteTags.get(`v${target}`) ?? null,
    releaseSha: await readReleaseSha(repository, target),
  });
  writeDecision(decision);
} else if (phase === 'repair-target') {
  const repairTarget = [...readRemoteTags().entries()]
    .filter(([, sha]) => sha === headSha)
    .map(([tag]) => tag)
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort(compareTags)
    .at(-1)
    ?.slice(1);
  writeDecision({ target: repairTarget ?? null });
} else {
  throw new Error('Usage: inspect-release.mjs bootstrap | repair-target | target <version>');
}

function writeDecision(decision) {
  if ('error' in decision) throw new Error(decision.error);
  for (const [name, value] of Object.entries(decision))
    appendFileSync(outputPath, `${name}=${value ?? ''}\n`);
}

function readRemoteTags() {
  const output = command('git', ['ls-remote', '--tags', 'origin', 'refs/tags/v*']);
  const tags = new Map();
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const [sha, reference] = line.split(/\s+/);
    const name = reference.replace('refs/tags/', '').replace(/\^\{\}$/, '');
    const peeled = reference.endsWith('^{}');
    if (peeled || !tags.has(name)) tags.set(name, sha);
  }
  return tags;
}

function readPublication(version) {
  return npmJson(['view', `gestalt-mobile@${version}`, 'version', 'gitHead', '--json']);
}

function npmJson(args) {
  const result = spawnSync('npm', args, { encoding: 'utf8' });
  if (result.status === 0) return JSON.parse(result.stdout || 'null');
  if (/E404|is not in this registry/i.test(result.stderr)) return null;
  throw new Error(`npm registry query failed with exit status ${result.status}`);
}

async function readReleaseSha(repository, version) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/v${version}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${requiredEnvironment('GITHUB_TOKEN')}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release query failed with status ${response.status}`);
  const release = await response.json();
  return release.target_commitish;
}

function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`${executable} failed with exit status ${result.status ?? result.signal}`);
  return result.stdout;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function compareTags(left, right) {
  const leftParts = left.slice(1).split('.').map(Number);
  const rightParts = right.slice(1).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}
