import { describe, expect, it } from 'vitest';
import { copyText } from './clipboard.js';
describe('copyText', () => {
  it('reports clipboard failure without throwing', async () =>
    expect(
      copyText('x', {
        writeText: async () => {
          throw new Error('denied');
        },
      }),
    ).resolves.toBe(false));
});
