import type { PendingInteraction } from '../../features/sessions/model/relay-session.js';

export function toPendingInteraction(input: {
  id: number;
  method: string;
  params: unknown;
}): PendingInteraction | null {
  const kind = {
    'item/commandExecution/requestApproval': 'commandApproval',
    'item/fileChange/requestApproval': 'fileChangeApproval',
    'item/permissions/requestApproval': 'permissionsApproval',
    'item/tool/requestUserInput': 'userInput',
  }[input.method] as PendingInteraction['kind'] | undefined;
  return kind ? { requestId: String(input.id), kind, payload: input.params } : null;
}
