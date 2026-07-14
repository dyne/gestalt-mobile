import { describe, expect, it } from 'vitest';
import { relayStatePath } from './state-path.js';
describe('relayStatePath', () => {
  it('isolates state by relay root', () =>
    expect(relayStatePath('/a', '/state')).not.toBe(relayStatePath('/b', '/state')));
});
