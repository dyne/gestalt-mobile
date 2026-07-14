export function profileAppServerCommand(profile: string): { command: string; args: string[] } {
  return profile === 'default'
    ? { command: 'codex', args: ['app-server', '--stdio'] }
    : { command: 'codex-profile', args: ['cli', profile, 'app-server', '--stdio'] };
}
