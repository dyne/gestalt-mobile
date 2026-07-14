export function protocolCompatibility(
  installedVersion: string | null,
  protocolVersion: string | null,
): { compatible: boolean; code?: 'CODEX_NOT_FOUND' | 'CODEX_PROTOCOL_MISMATCH' } {
  if (!installedVersion) return { compatible: false, code: 'CODEX_NOT_FOUND' };
  if (installedVersion !== protocolVersion)
    return { compatible: false, code: 'CODEX_PROTOCOL_MISMATCH' };
  return { compatible: true };
}
