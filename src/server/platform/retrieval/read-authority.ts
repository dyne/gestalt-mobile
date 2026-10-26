/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Codex 0.164 reports only the legacy sandbox projection, not resolved profile
 * read/deny rules. It proves unrestricted reads only without a named profile or
 * profile configuration. Never infer read grants from cwd or writableRoots.
 */
export function hasUnrestrictedReadAuthority(
  settings: unknown,
  configuration: unknown,
  cwd: string,
): boolean {
  const observed = record(settings);
  const config = record(configuration);
  if (!observed || observed.cwd !== cwd || !config) return false;
  if (
    observed.activePermissionProfile != null ||
    config.permissions != null ||
    config.default_permissions != null ||
    config.file_system != null ||
    config.fileSystem != null ||
    config.permission_profile != null ||
    config.sandbox_read_only != null
  )
    return false;
  const policy = record(observed.sandboxPolicy);
  if (!policy) return false;
  const keys = Object.keys(policy);
  if (policy.networkAccess !== undefined && typeof policy.networkAccess !== 'boolean') return false;
  if (
    ['excludeSlashTmp', 'excludeTmpdirEnvVar'].some(
      (key) => policy[key] !== undefined && typeof policy[key] !== 'boolean',
    )
  )
    return false;
  if (
    policy.writableRoots !== undefined &&
    (!Array.isArray(policy.writableRoots) ||
      !policy.writableRoots.every((root) => typeof root === 'string' && root.startsWith('/')))
  )
    return false;
  switch (policy.type) {
    case 'dangerFullAccess':
      return keys.every((key) => key === 'type');
    case 'readOnly':
      return keys.every((key) => ['type', 'networkAccess'].includes(key));
    case 'workspaceWrite':
      return keys.every((key) =>
        [
          'type',
          'networkAccess',
          'writableRoots',
          'excludeSlashTmp',
          'excludeTmpdirEnvVar',
        ].includes(key),
      );
    default:
      return false;
  }
}
