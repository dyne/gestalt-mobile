/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

const lines = [
  'Copyright (C) 2026 Dyne.org foundation',
  'Designed by Denis Roio <jaromil@dyne.org>',
  'SPDX-License-Identifier: AGPL-3.0-or-later',
];

const blockExtensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.css']);
const htmlExtensions = new Set(['.html', '.svelte']);
const lineExtensions = new Set(['.sh', '.bash']);
const yamlExtensions = new Set(['.yml', '.yaml']);

export function sourceHeader(path) {
  const extension = extname(path);
  if (blockExtensions.has(extension))
    return `/*\n${lines.map((line) => ` * ${line}`).join('\n')}\n */\n`;
  if (htmlExtensions.has(extension)) return `<!--\n${lines.join('\n')}\n-->\n`;
  if (lineExtensions.has(extension) || yamlExtensions.has(extension))
    return `${lines.map((line) => `# ${line}`).join('\n')}\n`;
  return null;
}

export function validateSourceHeader(path, content) {
  const header = sourceHeader(path);
  if (!header) return [];
  const offset = content.startsWith('#!') ? content.indexOf('\n') + 1 : 0;
  const body = content.slice(offset).replace(/^\n/, '');
  const errors = [];
  if (!body.startsWith(header)) errors.push('missing or malformed header');
  if (content.split(header).length !== 2) errors.push('duplicate header');
  return errors;
}

export function insertSourceHeader(path, content) {
  const header = sourceHeader(path);
  if (!header || validateSourceHeader(path, content).length === 0) return content;
  if (content.startsWith('#!')) {
    const lineEnd = content.indexOf('\n');
    return `${content.slice(0, lineEnd + 1)}\n${header}${content.slice(lineEnd + 1)}`;
  }
  return `${header}\n${content}`;
}

export function repositorySourceFiles(cwd = process.cwd()) {
  const root = `file://${cwd.replace(/\/$/, '')}/`;
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path && sourceHeader(path) && existsSync(new URL(path, root)));
}

export function applySourceHeaders(paths, cwd = process.cwd()) {
  for (const path of paths) {
    const content = readFileSync(new URL(path, `file://${cwd.replace(/\/$/, '')}/`), 'utf8');
    const updated = insertSourceHeader(path, content);
    if (updated !== content)
      writeFileSync(new URL(path, `file://${cwd.replace(/\/$/, '')}/`), updated);
  }
}
