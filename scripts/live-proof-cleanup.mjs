/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { chmodSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

// Only disposable copies allocated by this proof may be made writable, and
// only after every launched resource has positively closed. Never follow links.
export function removeOwnedProofTree(root, identity, { processesClosed }) {
  if (!processesClosed) throw new Error('OWNED_PROOF_PROCESSES_NOT_CLOSED');
  const current = lstatSync(root);
  if (
    !basename(root).startsWith('l11-entry-') ||
    realpathSync(root) !== root ||
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.uid !== process.getuid()
  )
    throw new Error('OWNED_PROOF_IDENTITY_CHANGED');
  const directories = [];
  function inspect(path) {
    const info = lstatSync(path);
    if (info.uid !== process.getuid() || info.dev !== current.dev)
      throw new Error('OWNED_PROOF_TREE_UNSAFE');
    if (info.isSymbolicLink()) return; // rm unlinks it; chmod never touches its target.
    if (info.isDirectory()) {
      directories.push(path);
      for (const name of readdirSync(path)) inspect(join(path, name));
    } else if (!info.isFile() && !info.isSocket()) throw new Error('OWNED_PROOF_TREE_UNSAFE');
  }
  inspect(root);
  for (const path of directories) chmodSync(path, 0o700);
  rmSync(root, { recursive: true, force: false });
}
