/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AppServer } from '../codex/session-runtime.js';

/** Discovery children are globally reserved until these exact owned lifetimes
 * close. No PID-based adoption, interrupt, idle callback or elapsed-time proof.
 */
export class AuxiliaryLifetimes {
  private readonly children = new Set<Promise<void>>();
  private unverified = false;
  record(process: AppServer): void {
    if (!process.waitForExit) {
      this.unverified = true;
      return;
    }
    const exited = process.waitForExit();
    this.children.add(exited);
    // Retain failed close evidence rather than silently releasing its reservation.
    void exited.then(
      () => this.children.delete(exited),
      () => {
        this.unverified = true;
      },
    );
  }
  async settle(): Promise<{
    roots: number;
    descendants: number;
    commands: number;
    approvals: number;
    unknown: boolean;
  }> {
    if (this.unverified) throw new Error('LIVE_AUXILIARY_LIFETIME_UNVERIFIED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.children]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('LIVE_AUXILIARY_BUSY')), 5000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.unverified || this.children.size)
      throw new Error('LIVE_AUXILIARY_LIFETIME_UNVERIFIED');
    return { roots: 0, descendants: 0, commands: 0, approvals: 0, unknown: false };
  }
}
