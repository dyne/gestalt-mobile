export type StartForm = { workspaceId: string; profile: string };
export function validateStartForm(form: StartForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.workspaceId) errors.workspaceId = 'Choose a workspace.';
  if (!form.profile) errors.profile = 'Choose a profile.';
  return errors;
}
