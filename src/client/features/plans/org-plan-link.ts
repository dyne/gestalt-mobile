/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const orgReference = /^(.*\.org)(?::\d+(?::\d+)?)?(?:#L\d+(?:C\d+)?)?$/;

function decodeReference(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function absoluteSegments(value: string): string[] | null {
  if (!value.startsWith('/') || value.includes('\0')) return null;
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** Maps a local Org-file link to the selected workspace's safe relative plan name. */
export function workspacePlanNameFromHref(href: string, workspacePath: string): string | null {
  const decodedHref = decodeReference(href);
  const decodedWorkspace = decodeReference(workspacePath);
  const match = decodedHref ? orgReference.exec(decodedHref) : null;
  if (!match || !decodedWorkspace) return null;

  const fileSegments = absoluteSegments(match[1] ?? '');
  const workspaceSegments = absoluteSegments(decodedWorkspace);
  if (!fileSegments || !workspaceSegments || fileSegments.length <= workspaceSegments.length)
    return null;
  if (workspaceSegments.some((segment, index) => fileSegments[index] !== segment)) return null;

  const planName = fileSegments.slice(workspaceSegments.length).join('/');
  return planName.endsWith('.org') && planName !== '.org' ? planName : null;
}

/** True only for absolute host-filesystem Org references handled by the Plan tab. */
export function isLocalOrgHref(href: string): boolean {
  const decoded = decodeReference(href);
  if (!decoded) return false;
  const match = orgReference.exec(decoded);
  return Boolean(match && absoluteSegments(match[1] ?? ''));
}
