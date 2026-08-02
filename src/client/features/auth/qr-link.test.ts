/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { bootstrapLink, bootstrapQrDataUrl } from './qr-link.js';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async (value: string) => `qr:${value}`) },
}));

describe('first-device QR link', () => {
  it('encodes only the canonical origin and bootstrap hint', async () => {
    const link = bootstrapLink('https://relay.example/');
    expect(link).toBe('https://relay.example/?bootstrap=1');
    expect(link).not.toMatch(/challenge|cookie|credential|token|secret/i);
    await expect(bootstrapQrDataUrl('https://relay.example/')).resolves.toBe(`qr:${link}`);
  });
});
