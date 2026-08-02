/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import QRCode from 'qrcode';

export function bootstrapLink(canonicalOrigin: string): string {
  return `${canonicalOrigin.replace(/\/$/, '')}/?bootstrap=1`;
}

export async function bootstrapQrDataUrl(canonicalOrigin: string): Promise<string> {
  return QRCode.toDataURL(bootstrapLink(canonicalOrigin), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  });
}

export async function enrollmentQrDataUrl(link: string): Promise<string> {
  return QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 1, width: 256 });
}
