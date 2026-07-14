export type RelayInteractionKind =
  'commandApproval' | 'fileChangeApproval' | 'permissionsApproval' | 'userInput';
export function isInteractionKind(value: string): value is RelayInteractionKind {
  return ['commandApproval', 'fileChangeApproval', 'permissionsApproval', 'userInput'].includes(
    value,
  );
}
