export function profileAppServerCommand(_profile: string): { command: string; args: string[] } {
  void _profile;
  return { command: 'codex', args: ['app-server', '--stdio'] };
}
