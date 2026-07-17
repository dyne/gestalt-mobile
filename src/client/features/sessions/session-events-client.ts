/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

type RelayEnvelope = {
  type: string;
  event?: { sequence: number; type: string; payload: unknown };
};

export function applyRelayEvent(
  cursor: number,
  envelope: RelayEnvelope,
  onDelta: (text: string) => void,
  onGap: (sequence: number) => void = () => {},
): number {
  if (envelope.type !== 'relay.event' || !envelope.event || envelope.event.sequence <= cursor)
    return cursor;
  if (envelope.event.sequence > cursor + 1) {
    onGap(envelope.event.sequence);
    return cursor;
  }
  if (envelope.event.type === 'agentMessageDelta') {
    const text = (envelope.event.payload as { text?: string }).text;
    if (text) onDelta(text);
  }
  return envelope.event.sequence;
}
