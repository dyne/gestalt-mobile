/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Actual canonical durable journals plus their recorded source postconditions.
 * Only digests leave this reader; no prompts or journal bodies are retained. */
export function helperCheckpointDigest(appRoot: string): string {
  try {
    const files: [string, string][] = [],
      sources = new Set<string>();
    let bytes = 0;
    const read = (path: string): string => {
      const stat = lstatSync(path);
      bytes += stat.size;
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        realpathSync(path) !== path ||
        stat.size > 8 * 1024 * 1024 ||
        bytes > 32 * 1024 * 1024
      )
        throw new Error();
      return readFileSync(path, 'utf8');
    };
    const source = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) source(item);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === 'sourceFile' && typeof item === 'string' && item) {
          const path = isAbsolute(item) ? item : join(appRoot, item),
            tail = relative(appRoot, path);
          if (!tail || tail === '..' || tail.startsWith(`..${sep}`) || isAbsolute(tail))
            throw new Error();
          sources.add(path);
        } else if (item && typeof item === 'object') source(item);
      }
    };
    for (const directory of [
      join(appRoot, '.impeccable/live/sessions'),
      join(appRoot, '.impeccable-live/sessions'),
    ]) {
      try {
        if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)
          throw new Error();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const name of readdirSync(directory).sort()) {
        if (!/^[a-zA-Z0-9_-]+\.(jsonl|snapshot\.json)$/.test(name) || files.length >= 1024)
          throw new Error();
        const path = join(directory, name),
          content = read(path);
        files.push([relative(appRoot, path), createHash('sha256').update(content).digest('hex')]);
        if (name.endsWith('.jsonl'))
          for (const line of content.split('\n')) {
            if (line.trim()) source(JSON.parse(line));
          }
        else source(JSON.parse(content));
      }
    }
    for (const path of [...sources].sort()) {
      let content: string;
      try {
        content = read(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          files.push([relative(appRoot, path), 'absent']);
          continue;
        }
        throw error;
      }
      files.push([relative(appRoot, path), createHash('sha256').update(content).digest('hex')]);
    }
    return createHash('sha256').update(JSON.stringify(files)).digest('hex');
  } catch {
    throw new Error('LIVE_HELPER_CHECKPOINT_UNVERIFIED');
  }
}
