/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  mkdirSync,
  symlinkSync,
  existsSync,
  statSync,
  copyFileSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { normalizeSkillProfileName } from '../../features/skills/model/skill-profile.js';

/**
 * Base directory holding gestalt-owned kimi web state:
 * `<home>/.codex-gestalt/gestalt-mobile/kimi/<profileKey>/`.
 */
export function kimiStateBase(homeDirectory: string): string {
  return join(resolve(homeDirectory), '.codex-gestalt', 'gestalt-mobile', 'kimi');
}

export type KimiShareDir = {
  /** Isolated KIMI_SHARE_DIR handed to the per-profile `kimi web` process. */
  shareDir: string;
  /** Gestalt-materialized skills directory referenced via `extra_skill_dirs`. */
  skillsDir: string;
  profileDir: string;
};

const AUTH_LINKS = ['credentials', 'oauth', 'device_id', 'region'] as const;

/**
 * Builds one isolated share dir per skill-profile key. Auth material is
 * symlinked from the user's real `~/.kimi-code` home so every gestalt-owned
 * kimi web instance shares the user's login; `config.toml` is copied (never
 * symlinked) so gestalt can patch it without mutating user configuration.
 */
export function prepareKimiShareDir(input: {
  stateBase: string;
  profileKey: string;
  sourceShareDir: string;
}): KimiShareDir {
  const profileKey = normalizeSkillProfileName(input.profileKey);
  const profileDir = join(input.stateBase, profileKey);
  const shareDir = join(profileDir, 'share');
  const skillsDir = join(profileDir, 'skills');
  mkdirSync(shareDir, { recursive: true, mode: 0o700 });
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });

  for (const name of AUTH_LINKS) {
    const source = join(input.sourceShareDir, name);
    if (!existsSync(source)) continue;
    const link = join(shareDir, name);
    removeIfPresent(link);
    symlinkSync(source, link);
  }

  copyConfig(sourceConfig(input.sourceShareDir), join(shareDir, 'config.toml'));
  return { shareDir, skillsDir, profileDir };
}

function sourceConfig(sourceShareDir: string): string | null {
  const candidate = join(sourceShareDir, 'config.toml');
  return existsSync(candidate) ? candidate : null;
}

/** Refreshes the copied config when the user's own config is newer. */
function copyConfig(source: string | null, destination: string): void {
  if (!source) {
    rmSync(destination, { force: true });
    return;
  }
  if (existsSync(destination) && statSync(destination).mtimeMs >= statSync(source).mtimeMs) {
    return;
  }
  copyFileSync(source, destination);
}

/** Removes a path if it exists, following lstat so broken symlinks count too. */
function removeIfPresent(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}
