import { createHash } from 'node:crypto';
export function workspaceId(path: string): string {
  return createHash('sha256').update(path).digest('base64url');
}
