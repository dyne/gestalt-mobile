type RelayEnvelope = {
  type: string;
  event?: { sequence: number; type: string; payload: unknown };
};

export function applyRelayEvent(
  cursor: number,
  envelope: RelayEnvelope,
  onDelta: (text: string) => void,
): number {
  if (envelope.type !== 'relay.event' || !envelope.event || envelope.event.sequence <= cursor)
    return cursor;
  if (envelope.event.type === 'agentMessageDelta') {
    const text = (envelope.event.payload as { text?: string }).text;
    if (text) onDelta(text);
  }
  return envelope.event.sequence;
}
