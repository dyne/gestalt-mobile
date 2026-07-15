/** Settings accepted by Codex's generated thread/start contract. */
export type StartSessionSettings = {
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-request' | 'never';
};
