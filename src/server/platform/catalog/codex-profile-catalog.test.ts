import { describe, expect, it } from 'vitest';
import { CodexProfileCatalog } from './codex-profile-catalog.js';

describe('CodexProfileCatalog', () => {
  it('maps valid codex-profile status JSON without leaking homes', async () => {
    const catalog = new CodexProfileCatalog(async () =>
      JSON.stringify({
        profiles: [{ name: 'default', home: '/private', state: 'ok', status: 'ready' }],
      }),
    );
    await expect(catalog.list()).resolves.toEqual([
      { name: 'default', state: 'ok', status: 'ready' },
    ]);
  });
});
