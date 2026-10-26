/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { SessionRetrievalReadiness } from '../../../shared/contracts/retrieval-readiness.js';

type Observation = SessionRetrievalReadiness['repositories'][number] & {
  activityOrder?: { occurredAt: string; sequence?: number };
};
type ReadinessView = Omit<SessionRetrievalReadiness, 'repositories'> & {
  repositories: Observation[];
};
const sequenceNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Journal replay is historical evidence, never authority for a different/current runtime. */
export function applyReadinessActivity(
  current: ReadinessView | null,
  event: { type: string; payload: unknown; occurredAt?: string; sequence?: number },
): ReadinessView | null {
  if (
    event.type !== 'activity.updated' ||
    !current?.runtimeId ||
    !current.observedAt ||
    !event.occurredAt ||
    !Number.isFinite(Date.parse(current.observedAt)) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    Date.parse(event.occurredAt) <= Date.parse(current.observedAt)
  )
    return current;
  const payload = event.payload as {
    runtimeId?: string;
    repositoryReadiness?: SessionRetrievalReadiness['repositories'][number];
  } | null;
  const observed = payload?.repositoryReadiness;
  if (
    payload?.runtimeId !== current.runtimeId ||
    !observed?.readiness?.repository ||
    typeof observed.threadId !== 'string'
  )
    return current;
  const prior = current.repositories.find(
    (entry) =>
      entry.threadId === observed.threadId &&
      entry.readiness.repository?.id === observed.readiness.repository?.id,
  );
  // Keep each context's watermark with its observation; never evict ordering
  // evidence to admit a replayed context when the runtime's bounded scope is full.
  if (!prior && current.repositories.length >= 64) return current;
  const sequence = sequenceNumber(event.sequence);
  const previous = prior?.activityOrder;
  if (previous) {
    const time = Date.parse(event.occurredAt);
    const previousTime = Date.parse(previous.occurredAt);
    if (
      time < previousTime ||
      (previous.sequence !== undefined &&
        (sequence === undefined || sequence <= previous.sequence)) ||
      (time === previousTime && (previous.sequence === undefined || sequence === undefined))
    )
      return current;
  }
  return {
    ...current,
    repositories: [
      ...current.repositories.filter(
        (entry) =>
          entry.threadId !== observed.threadId ||
          entry.readiness.repository?.id !== observed.readiness.repository?.id,
      ),
      {
        ...observed,
        activityOrder: {
          occurredAt: event.occurredAt,
          ...(sequence === undefined ? {} : { sequence }),
        },
      },
    ],
  };
}
