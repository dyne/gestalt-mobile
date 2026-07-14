export type DomainErrorCode =
  | 'INVALID_SESSION_VALUE'
  | 'SESSION_NOT_READY'
  | 'SESSION_TURN_ACTIVE'
  | 'TURN_NOT_ACTIVE'
  | 'INTERACTION_ALREADY_PENDING'
  | 'INTERACTION_NOT_PENDING';

export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode) {
    super(code);
    this.name = 'DomainError';
  }
}
