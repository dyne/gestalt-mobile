/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const releaseTypes = {
  feat: 'minor',
  feature: 'minor',
  fix: 'patch',
  bugfix: 'patch',
  perf: 'patch',
  refactor: 'patch',
  test: 'patch',
  tests: 'patch',
};

export function conventionalNextVersion(current, commits) {
  let bump = null;
  for (const commit of commits) {
    if (/BREAKING[ -]CHANGE:/i.test(commit) || /^[a-z]+(?:\([^)]*\))?!:/i.test(commit)) {
      bump = 'major';
      break;
    }
    const type = /^([a-z]+)(?:\([^)]*\))?:/i.exec(commit)?.[1]?.toLowerCase();
    const candidate = type ? releaseTypes[type] : undefined;
    if (candidate === 'minor') bump = 'minor';
    else if (candidate === 'patch' && !bump) bump = 'patch';
  }
  if (!bump) return null;
  const [major, minor, patch] = parseVersion(current);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function decideBootstrap({ remoteTags, npmVersions, npmPublication, headSha }) {
  if (remoteTags.includes('v0.1.0')) return { mode: 'semver', target: null };
  if (remoteTags.length > 0)
    return failure(`Unexpected pre-bootstrap release tags: ${remoteTags.join(', ')}`);
  if (npmVersions.some((version) => version !== '0.1.0'))
    return failure(`Unexpected pre-bootstrap npm versions: ${npmVersions.join(', ')}`);
  if (!npmVersions.includes('0.1.0')) return { mode: 'bootstrap', target: '0.1.0' };
  if (npmPublication?.gitHead !== headSha)
    return failure('gestalt-mobile@0.1.0 belongs to a different commit');
  return { mode: 'repair', target: '0.1.0' };
}

export function decideTarget({ target, headSha, npmPublication, tagSha, releaseSha }) {
  parseVersion(target);
  if (!npmPublication) {
    if (tagSha || releaseSha) return failure('GitHub metadata exists without an npm publication');
    return { publish: true, tag: true, release: true, complete: false };
  }
  if (npmPublication.version !== target || npmPublication.gitHead !== headSha)
    return failure(`gestalt-mobile@${target} does not match the verified commit`);
  if (tagSha && tagSha !== headSha) return failure(`v${target} points to a different commit`);
  if (releaseSha && releaseSha !== headSha)
    return failure(`GitHub Release v${target} points to a different commit`);
  if (releaseSha && !tagSha) return failure('GitHub Release exists without its Git tag');
  return {
    publish: false,
    tag: !tagSha,
    release: !releaseSha,
    complete: Boolean(tagSha && releaseSha),
  };
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  return match.slice(1).map(Number);
}

function failure(error) {
  return { error };
}
