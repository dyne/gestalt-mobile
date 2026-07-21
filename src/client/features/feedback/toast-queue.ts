/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ToastKind = 'error' | 'success' | 'info';
export type ToastPauseReason = 'hover' | 'focus';

export type Toast = {
  id: string;
  kind: ToastKind;
  code?: string;
  message: string;
  occurrences: number;
};

export type ToastInput = Omit<Toast, 'id' | 'occurrences'>;

export type ToastQueue = {
  enqueue(input: ToastInput): string;
  dismiss(id: string): void;
  pause(id: string, reason: ToastPauseReason): void;
  resume(id: string, reason: ToastPauseReason): void;
  snapshot(): Toast[];
  subscribe(listener: (toasts: Toast[]) => void): () => void;
};

/** Success toasts remain for 5 seconds; information toasts remain for 7 seconds. */
export const toastTimeouts = { error: null, success: 5_000, info: 7_000 } as const;
export const visibleToastLimit = 3;

type TimerHandle = ReturnType<typeof setTimeout>;
type TimerState = {
  handle: TimerHandle | null;
  remaining: number;
  startedAt: number;
  pauseReasons: Set<ToastPauseReason>;
};

type QueueOptions = {
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
};

export function createToastQueue(options: QueueOptions = {}): ToastQueue {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const listeners = new Set<(toasts: Toast[]) => void>();
  const timers = new Map<string, TimerState>();
  let toasts: Toast[] = [];
  let sequence = 0;

  const snapshot = (): Toast[] => toasts.map((toast) => ({ ...toast }));
  const notify = (): void => listeners.forEach((listener) => listener(snapshot()));

  const clearScheduled = (id: string): void => {
    const timer = timers.get(id);
    if (timer?.handle) clearTimer(timer.handle);
    if (timer) timer.handle = null;
  };

  const dismiss = (id: string): void => {
    if (!toasts.some((toast) => toast.id === id)) return;
    clearScheduled(id);
    timers.delete(id);
    toasts = toasts.filter((toast) => toast.id !== id);
    notify();
  };

  const schedule = (id: string): void => {
    const timer = timers.get(id);
    if (!timer || timer.pauseReasons.size > 0) return;
    timer.startedAt = now();
    timer.handle = setTimer(() => dismiss(id), timer.remaining);
  };

  return {
    enqueue(input) {
      if (input.kind === 'error') {
        const duplicate = toasts.find(
          (toast) =>
            toast.kind === 'error' &&
            (input.code ? toast.code === input.code : toast.message === input.message),
        );
        if (duplicate) {
          toasts = toasts.map((toast) =>
            toast.id === duplicate.id ? { ...toast, occurrences: toast.occurrences + 1 } : toast,
          );
          notify();
          return duplicate.id;
        }
      }

      const id = `toast-${++sequence}`;
      const toast: Toast = { ...input, id, occurrences: 1 };
      toasts = [...toasts, toast];
      const timeout = toastTimeouts[input.kind];
      if (timeout !== null) {
        timers.set(id, {
          handle: null,
          remaining: timeout,
          startedAt: now(),
          pauseReasons: new Set(),
        });
        schedule(id);
      }
      notify();
      return id;
    },
    dismiss,
    pause(id, reason) {
      const timer = timers.get(id);
      if (!timer || timer.pauseReasons.has(reason)) return;
      timer.pauseReasons.add(reason);
      if (timer.handle) {
        timer.remaining = Math.max(0, timer.remaining - (now() - timer.startedAt));
        clearScheduled(id);
      }
    },
    resume(id, reason) {
      const timer = timers.get(id);
      if (!timer || !timer.pauseReasons.delete(reason) || timer.pauseReasons.size > 0) return;
      schedule(id);
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
}
