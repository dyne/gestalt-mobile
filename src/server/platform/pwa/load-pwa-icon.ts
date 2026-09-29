/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import type { PwaIcon } from '../../features/pwa/register-routes.js';

const maxIconBytes = 5 * 1024 * 1024;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function loadPwaIcon(path: string): Promise<PwaIcon> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`Unable to read --icon file: ${path}`);
  }
  if (bytes.length === 0 || bytes.length > maxIconBytes)
    throw new Error('--icon must be a non-empty SVG or PNG no larger than 5 MiB');

  const extension = extname(path).toLowerCase();
  if (extension === '.svg') {
    if (!/<svg(?:\s|>)/i.test(bytes.toString('utf8')))
      throw new Error('--icon SVG does not contain an <svg> root');
    return { bytes, contentType: 'image/svg+xml', extension: 'svg', sizes: 'any' };
  }
  if (
    extension !== '.png' ||
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('--icon PNG has an invalid header');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error('--icon PNG has invalid dimensions');
  return { bytes, contentType: 'image/png', extension: 'png', sizes: `${width}x${height}` };
}
