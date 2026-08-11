/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type FollowTailReason = 'content' | 'explicit' | 'initial';
export type FollowTailOptions = Readonly<{
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  reducedMotion(): boolean;
  scrollTail(behavior: ScrollBehavior): void;
}>;

/** Coalesces post-DOM tail scrolling; the observer is the sole follow-state writer. */
export class ChatFollowTail {
  #following = true;
  #frame: number | null = null;
  readonly #options: FollowTailOptions;
  constructor(options: FollowTailOptions) {
    this.#options = options;
  }
  get following(): boolean {
    return this.#following;
  }
  observeTail(isIntersecting: boolean): void {
    this.#following = isIntersecting;
  }
  reset(): void {
    this.cancel();
    this.#following = true;
  }
  request(reason: FollowTailReason): void {
    if (reason !== 'content') this.#following = true;
    if (reason === 'content' && !this.#following) return;
    if (this.#frame !== null) return;
    this.#frame = this.#options.requestFrame(() => {
      this.#frame = null;
      this.#options.scrollTail(
        reason === 'initial' || this.#options.reducedMotion() ? 'auto' : 'smooth',
      );
    });
  }
  cancel(): void {
    if (this.#frame !== null) this.#options.cancelFrame(this.#frame);
    this.#frame = null;
  }
}
