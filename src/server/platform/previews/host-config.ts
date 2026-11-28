/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createPreviewConfig } from '../../config.js';

const previewSettings = z.strictObject({
  relayOrigin: z.string(),
  origin: z.string(),
  gatewayPort: z.number().optional(),
  targetPort: z.number().optional(),
});
const previewFile = z.union([previewSettings, z.array(previewSettings)]);

function previewHostConfigPath(home: string): string {
  return join(home, '.codex-gestalt', 'gestalt-mobile', 'preview.json');
}

export async function readPreviewHostConfig(home: string, publicOrigin: string, relayPort: number) {
  const file = await open(
    previewHostConfigPath(home),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!file) return;
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.size > 4096
    )
      throw new Error('Invalid preview configuration file');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead === buffer.length) throw new Error('Invalid preview configuration file');
    const fileSettings = previewFile.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
    const entries = Array.isArray(fileSettings) ? fileSettings : [fileSettings];
    const matching = entries.filter((entry) => entry.relayOrigin === publicOrigin);
    if (matching.length > 1) throw new Error('Duplicate relay origin in preview configuration');
    const [settings] = matching;
    if (settings) return createPreviewConfig(settings, publicOrigin, relayPort, true);
  } finally {
    await file.close();
  }
}
