export type InteractionState = 'pending' | 'submitting' | 'resolved' | 'failed';
export function canSubmitInteraction(state: InteractionState): boolean {
  return state === 'pending' || state === 'failed';
}
