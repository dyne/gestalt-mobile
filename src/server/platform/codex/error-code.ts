export function protocolErrorCode(
  installed: string | null,
  expected: string | null,
): 'CODEX_NOT_FOUND' | 'CODEX_PROTOCOL_MISMATCH' | null {
  if (!installed) return 'CODEX_NOT_FOUND';
  return installed === expected ? null : 'CODEX_PROTOCOL_MISMATCH';
}
