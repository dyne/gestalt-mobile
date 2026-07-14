export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export function requiresApproval(policy: ApprovalPolicy, requested: boolean): boolean {
  return policy !== 'never' && requested;
}
