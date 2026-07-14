import { describe, expect, it } from 'vitest';

import { readCursor, readSelectedSession, saveCursor, saveSelectedSession } from './session-memory.js';

describe('session memory', () => {
  it('retains selected session and its replay cursor', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } as unknown as Storage;
    saveSelectedSession(storage, 'session-1');
    saveCursor(storage, 'session-1', 42);
    expect(readSelectedSession(storage)).toBe('session-1');
    expect(readCursor(storage, 'session-1')).toBe(42);
  });
});
