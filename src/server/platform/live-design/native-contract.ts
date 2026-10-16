/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Reviewed minimal metadata-mask composition patch, hosted run38645681271.
 * The CLI, sandbox helper and bwrap are one verified GNU artifact. The code-mode
 * host is the signed official static MUSL build at the same source revision. */
export const LIVE_CODEX_SHA256 = 'b2730ae901da317bcc5933d9b87de6dfbea3e46a46b64f806e4268fd9a095578';
export const LIVE_CODEX_SOURCE = '979011409de0a60b52f179721948e65531d26144';
export const LIVE_CODEX_BWRAP_SHA256 =
  '335aa87510fc0eee1bcdbedd3d9bf4aa4d112cffed72d5f1ad7a10b6cc855066';
export const LIVE_CODEX_SANDBOX_SHA256 =
  '396915091a1f0387b48fd06e98d06e61d22f6ff6af33bc806891a634ee03d199';
export const LIVE_CODEX_CODE_MODE_HOST_SHA256 =
  'e87096087c02aa6ab90a5a85031659665aa0bf3ee20c07ca0b8ab701c83fcd5b';

/** Verify the complete reviewed image set before any trusted-host invocation. */
export function assertLiveNativeInstallation(binary: string): void {
  const root = dirname(binary);
  for (const [path, digest] of [
    [binary, LIVE_CODEX_SHA256],
    [join(root, 'codex-linux-sandbox'), LIVE_CODEX_SANDBOX_SHA256],
    [join(root, 'codex-resources/bwrap'), LIVE_CODEX_BWRAP_SHA256],
    [join(root, 'codex-code-mode-host'), LIVE_CODEX_CODE_MODE_HOST_SHA256],
  ]) {
    try {
      const info = lstatSync(path!);
      if (
        realpathSync(path!) !== path ||
        !info.isFile() ||
        !(info.mode & 0o111) ||
        info.mode & 0o022 ||
        ![0, process.getuid?.()].includes(info.uid) ||
        createHash('sha256').update(readFileSync(path!)).digest('hex') !== digest
      )
        throw new Error();
    } catch {
      throw new Error('LIVE_RUNTIME_BINARY_UNVERIFIED');
    }
  }
}
