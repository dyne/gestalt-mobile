/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readdir } from 'node:fs/promises';
import { relative, join } from 'node:path';

import {
  authorizationStressVitestSpecs,
  browserEvidenceSpecs,
  browserRealAuthSpecs,
} from './test-lanes.mjs';

async function files(directory, predicate) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return files(path, predicate);
      return predicate(path) ? [path] : [];
    }),
  );
  return nested.flat();
}

function laneReport(name, members) {
  console.log(`${name} (${members.length})`);
  for (const member of members) console.log(`  ${member}`);
}

const root = process.cwd();
const vitestFiles = (
  await Promise.all(
    ['src', 'test', 'scripts'].map((directory) =>
      files(directory, (path) => path.endsWith('.test.ts')),
    ),
  )
)
  .flat()
  .map((path) => relative(root, path))
  .sort();
const browserFiles = (await files('test/e2e', (path) => path.endsWith('.spec.ts')))
  .map((path) => relative('test/e2e', path))
  .sort();
const browserFunctional = browserFiles.filter((file) => !browserRealAuthSpecs.includes(file));

const lanes = {
  vitest: vitestFiles,
  'authorization-stress': authorizationStressVitestSpecs,
  'browser-functional': browserFunctional,
  'browser-evidence': browserEvidenceSpecs,
  'real-auth': browserRealAuthSpecs,
};

const configured = [...browserEvidenceSpecs, ...browserRealAuthSpecs];
const unknown = configured.filter((file) => !browserFiles.includes(file));
const duplicateEvidence = browserEvidenceSpecs.filter(
  (file, index) => browserEvidenceSpecs.indexOf(file) !== index,
);
const unassignedVitest = vitestFiles.filter((file) => !lanes.vitest.includes(file));
const unassignedBrowser = browserFiles.filter(
  (file) => !browserFunctional.includes(file) && !configured.includes(file),
);

for (const [name, members] of Object.entries(lanes)) laneReport(name, members);
if (
  unknown.length ||
  duplicateEvidence.length ||
  unassignedVitest.length ||
  unassignedBrowser.length
) {
  console.error(
    JSON.stringify({ unknown, duplicateEvidence, unassignedVitest, unassignedBrowser }),
  );
  process.exitCode = 1;
}
