import { describe, expect, it } from 'vitest';
import { legacyRelayStatePath, relayStatePath } from './state-path.js';
describe('relayStatePath', () => {
  it('isolates state by relay root', () =>
    expect(relayStatePath('/a', '/state')).not.toBe(relayStatePath('/b', '/state')));

  it('uses the new application name without changing the legacy location', () => {
    expect(relayStatePath('/a', '/state')).toContain('/gestalt-mobile/');
    expect(legacyRelayStatePath('/a', '/state')).toContain('/codex-relay/');
  });
});
