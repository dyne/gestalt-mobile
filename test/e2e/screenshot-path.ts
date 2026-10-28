/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { join } from 'node:path';

export function screenshotPath(filename: string): string {
  return join(process.env.PLAYWRIGHT_EVIDENCE_DIR ?? 'output/playwright', filename);
}
