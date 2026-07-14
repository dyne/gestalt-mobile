import { describe, expect, it } from 'vitest';
import { readDraft, saveDraft } from './draft-store.js';
describe('draft store', () => {
  it('retains drafts per session', () => {
    const storage = new Map<string, string>();
    const fake = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as unknown as Storage;
    saveDraft(fake, 'one', 'keep me');
    expect(readDraft(fake, 'two')).toBe('');
    expect(readDraft(fake, 'one')).toBe('keep me');
  });
});
