export type HealthResponse = {
  status: 'ok' | 'degraded';
  version: string;
  codex: { installedVersion: string | null; protocolVersion: string | null; compatible: boolean };
};
