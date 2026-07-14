export type SessionEvent<TType extends string = string, TPayload = unknown> = {
  sessionId: string;
  sequence: number;
  type: TType;
  occurredAt: string;
  payload: TPayload;
};
