import { createHash } from 'node:crypto';
import { join } from 'node:path';
export function relayStatePath(root: string, stateHome: string): string {
  return join(
    stateHome,
    'codex-relay',
    createHash('sha256').update(root).digest('hex').slice(0, 12),
    'relay.sqlite',
  );
}
