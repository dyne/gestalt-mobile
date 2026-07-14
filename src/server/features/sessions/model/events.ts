export type RelaySessionEvent = {
  type:
    | 'ThreadBound'
    | 'TurnStarted'
    | 'TurnCompleted'
    | 'InteractionRequested'
    | 'InteractionResolved'
    | 'RecoveryBegan'
    | 'SessionRestored'
    | 'AttentionRequired'
    | 'SessionStopped'
    | 'SessionReleased';
  occurredAt: string;
  sessionId: string;
};
