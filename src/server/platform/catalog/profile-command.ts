export function profileAppServerArgs(profile: string): string[] {
  return ['cli', profile, 'app-server', '--stdio'];
}
