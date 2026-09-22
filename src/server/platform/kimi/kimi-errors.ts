/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Error surfaced by the kimi web client. `code` is the protocol business code
 * (0 means success on the wire, so a thrown error always has code !== 0);
 * HTTP-level failures are normalized to code -1 with the transport message.
 */
export class KimiWebError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly requestId?: string,
  ) {
    super(boundMessage(message));
    this.name = 'KimiWebError';
  }
}

export function isKimiWebError(error: unknown): error is KimiWebError {
  return error instanceof KimiWebError;
}

/** Caps and redacts wire messages before they enter logs or client payloads. */
export function boundMessage(message: string): string {
  return message
    .replace(/((?:authorization|token|api[_ -]?key|password)\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(authentication failed:\s*).*/i, '$1[REDACTED]')
    .slice(0, 256);
}
