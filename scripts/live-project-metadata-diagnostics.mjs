/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';

// Native source 9790114 linux-sandbox/src/linux_run_main.rs:1348–1387.
// This mutable registry is diagnostic evidence only, NEVER admission authority.
function markerName(path) {
  let value = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path))
    value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return value.toString(16).padStart(16, '0');
}

function ownedDirectory(path) {
  const stat = lstatSync(path);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === process.getuid() &&
    !(stat.mode & 0o022) &&
    realpathSync(path) === path
  );
}

function nativeAncestor(pid, nativePath) {
  let native = false;
  const seen = new Set();
  for (let depth = 0; depth < 32 && pid > 1 && !seen.has(pid); depth++) {
    if (pid === process.pid) return native;
    seen.add(pid);
    const path = `/proc/${pid}`;
    if (lstatSync(path).uid !== process.getuid()) return false;
    native ||= readlinkSync(join(path, 'exe')) === nativePath;
    const stat = readFileSync(join(path, 'stat'), 'utf8');
    if (stat.length > 8192) return false;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return false;
    pid = Number(fields[1]);
    if (!Number.isSafeInteger(pid)) return false;
  }
  return false;
}

export function projectMetadataRegistryDiagnostics({ folder, temporaryDirectory, nativePath }) {
  try {
    const registry = join(
      temporaryDirectory,
      `codex-bwrap-synthetic-mount-targets-${process.getuid()}`,
    );
    const directory = join(registry, markerName(folder));
    if (!ownedDirectory(registry) || !ownedDirectory(directory))
      return { inspectionUnavailable: true };
    const names = readdirSync(directory);
    const result = {
      markerDirectoryPresent: true,
      markerCount: Math.min(names.length, 65),
      syntheticMarkers: 0,
      existingMarkers: 0,
      liveOwnedNativeMarkers: 0,
    };
    for (const name of names.slice(0, 64)) {
      if (!/^[1-9][0-9]{0,9}$/.test(name)) continue;
      let fd;
      try {
        fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 16) continue;
        const bytes = Buffer.alloc(17);
        const length = readSync(fd, bytes, 0, bytes.length, 0);
        if (length > 16) continue;
        const after = fstatSync(fd);
        if (after.size !== stat.size || after.ctimeMs !== stat.ctimeMs) continue;
        const marker = bytes.subarray(0, length).toString('utf8');
        if (marker === 'synthetic\n') result.syntheticMarkers++;
        else if (marker === 'existing\n') result.existingMarkers++;
        else continue;
        if (nativeAncestor(Number(name), nativePath)) result.liveOwnedNativeMarkers++;
      } catch {
        // Processes/markers can disappear during inspection; no authority follows.
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    return result;
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { markerDirectoryPresent: false }
      : { inspectionUnavailable: true };
  }
}
