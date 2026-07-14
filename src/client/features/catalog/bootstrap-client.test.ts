import { describe, expect, it } from 'vitest';
import { loadBootstrap } from './bootstrap-client.js';
describe('loadBootstrap', () => {
  it('returns the API payload', async () => {
    await expect(
      loadBootstrap(async () => new Response('{"ok":true}', { status: 200 }) as Response),
    ).resolves.toEqual({ ok: true });
  });
});
