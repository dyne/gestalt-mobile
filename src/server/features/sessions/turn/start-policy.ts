export function mayStartTurn(state: string, text: string): boolean {
  return state === 'ready' && text.trim().length > 0;
}
