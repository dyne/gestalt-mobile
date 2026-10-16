/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { isolatedProjectSocketFilter } from './project-network-filter.js';

// Evaluate the emitted classic BPF against seccomp_data, including both ABIs.
// This tests the filter decision table; kernel enforcement requires the hosted native proof.
function evaluate(syscall: number, arg0 = 0, arg1 = 0, architecture = 0xc000003e): number {
  const bytes = isolatedProjectSocketFilter();
  const data = new Map([
    [0, syscall],
    [4, architecture],
    [16, arg0],
    [24, arg1],
  ]);
  let accumulator = 0;
  for (let pc = 0; pc < bytes.length / 8; pc++) {
    const code = bytes.readUInt16LE(pc * 8);
    const value = bytes.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) accumulator = data.get(value) ?? 0;
    else if (code === 0x54) accumulator &= value;
    else if (code === 0x15 || code === 0x35)
      pc += (code === 0x15 ? accumulator === value : accumulator >= value)
        ? bytes[pc * 8 + 2]!
        : bytes[pc * 8 + 3]!;
    else if (code === 0x06) return value;
    else throw new Error('Unsupported instruction');
  }
  throw new Error('Missing decision');
}
describe('isolated project socket filter', () => {
  it('permits namespace-local IP listeners and connected stream subprocess IPC', () => {
    expect(evaluate(41, 2)).toBe(0x7fff0000);
    expect(evaluate(41, 10)).toBe(0x7fff0000);
    expect(evaluate(49)).toBe(0x7fff0000); // bind
    expect(evaluate(50)).toBe(0x7fff0000); // listen
    expect(evaluate(53, 1, 1 | 0x80000)).toBe(0x7fff0000);
    expect(evaluate(53, 1, 5 | 0x80000)).toBe(0x7fff0000);
  });
  it('denies Unix/raw-family sockets and reconnectable datagram pairs', () => {
    for (const family of [1, 16, 17, 40]) expect(evaluate(41, family)).toBe(0x00050001);
    expect(evaluate(53, 1, 2)).toBe(0x00050001);
  });
  it('blocks socket bypasses and unsupported or x32 ABIs', () => {
    for (const call of [101, 310, 311, 425, 426, 427, 321, 298])
      expect(evaluate(call)).toBe(0x00050001);
    expect(evaluate(41 | 0x40000000, 1)).toBe(0x80000000);
    expect(evaluate(41, 2, 0, 0x40000003)).toBe(0x80000000);
  });
});
