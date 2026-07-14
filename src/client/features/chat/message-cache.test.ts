import { describe, expect, it } from 'vitest';

import { createMessageCache, retainRecentMessages } from './message-cache.js';

describe('message cache', () => {
  it('keeps the most recent 200 chat messages', () => {
    const messages = Array.from({ length: 201 }, (_, index) => ({
      id: String(index), role: 'assistant' as const, text: String(index), complete: true,
    }));
    expect(retainRecentMessages(messages)).toHaveLength(200);
    expect(retainRecentMessages(messages)[0]?.id).toBe('1');
  });

  it('degrades to an empty no-op cache without IndexedDB', async () => {
    const cache = createMessageCache(undefined);
    await cache.write('session', []);
    await expect(cache.read('session')).resolves.toEqual([]);
  });
});
