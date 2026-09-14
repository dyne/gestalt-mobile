/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ToastKind = 'error' | 'success' | 'warning' | 'info';
export type ToastPauseReason = 'hover' | 'focus';

export type Toast = {
  id: string;
  kind: ToastKind;
  code?: string;
  message: string;
  occurrences: number;
};

export type NotificationHistoryItem = Toast & {
  createdAt: number;
  updatedAt: number;
};

export type ToastInput = Omit<Toast, 'id' | 'occurrences'>;

export type ToastQueue = {
  enqueue(input: ToastInput): string;
  dismiss(id: string): void;
  pause(id: string, reason: ToastPauseReason): void;
  resume(id: string, reason: ToastPauseReason): void;
  snapshot(): Toast[];
  historySnapshot(): NotificationHistoryItem[];
  subscribe(listener: (toasts: Toast[]) => void): () => void;
  subscribeHistory(listener: (items: NotificationHistoryItem[]) => void): () => void;
};

/** Errors persist; success and informational notices clear after a readable interval. */
export const toastTimeouts = { error: null, success: 5_000, warning: 10_000, info: 7_000 } as const;
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
  historyStorage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  historyLimit?: number;
};

export const NOTIFICATION_HISTORY_STORAGE_KEY = 'gestalt-mobile.notification-history';
export const notificationHistoryLimit = 50;

export function browserNotificationHistoryStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readHistory(
  storage: QueueOptions['historyStorage'],
  limit: number,
): NotificationHistoryItem[] {
  try {
    const decoded: unknown = JSON.parse(storage?.getItem(NOTIFICATION_HISTORY_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(decoded)) return [];
    return decoded
      .filter(
        (item): item is NotificationHistoryItem =>
          typeof item === 'object' &&
          item !== null &&
          typeof item.id === 'string' &&
          ['error', 'success', 'warning', 'info'].includes(String(item.kind)) &&
          typeof item.message === 'string' &&
          typeof item.occurrences === 'number' &&
          typeof item.createdAt === 'number' &&
          typeof item.updatedAt === 'number',
      )
      .slice(-limit);
  } catch {
    return [];
  }
}

export function createToastQueue(options: QueueOptions = {}): ToastQueue {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const listeners = new Set<(toasts: Toast[]) => void>();
  const historyListeners = new Set<(items: NotificationHistoryItem[]) => void>();
  const timers = new Map<string, TimerState>();
  let toasts: Toast[] = [];
  const historyLimit = options.historyLimit ?? notificationHistoryLimit;
  let history = readHistory(options.historyStorage, historyLimit);
  let sequence = 0;

  const snapshot = (): Toast[] => toasts.map((toast) => ({ ...toast }));
  const historySnapshot = (): NotificationHistoryItem[] =>
    [...history].reverse().map((item) => ({ ...item }));
  const notify = (): void => listeners.forEach((listener) => listener(snapshot()));
  const persistHistory = (): void => {
    try {
      options.historyStorage?.setItem(NOTIFICATION_HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch {
      // Notification delivery remains available when device-local storage is unavailable.
    }
  };
  const notifyHistory = (): void => {
    persistHistory();
    historyListeners.forEach((listener) => listener(historySnapshot()));
  };

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
      if (input.code) {
        const duplicate = toasts.find(
          (toast) => toast.kind === input.kind && toast.code === input.code,
        );
        if (duplicate) {
          toasts = toasts.map((toast) =>
            toast.id === duplicate.id ? { ...toast, occurrences: toast.occurrences + 1 } : toast,
          );
          history = history.map((item) =>
            item.id === duplicate.id
              ? { ...item, occurrences: item.occurrences + 1, updatedAt: now() }
              : item,
          );
          notify();
          notifyHistory();
          return duplicate.id;
        }
      }

      const timestamp = now();
      const id = `toast-${timestamp}-${++sequence}`;
      const toast: Toast = { ...input, id, occurrences: 1 };
      toasts = [...toasts, toast];
      history = [...history, { ...toast, createdAt: timestamp, updatedAt: timestamp }].slice(
        -historyLimit,
      );
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
      notifyHistory();
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
    historySnapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    subscribeHistory(listener) {
      historyListeners.add(listener);
      listener(historySnapshot());
      return () => historyListeners.delete(listener);
    },
  };
}
