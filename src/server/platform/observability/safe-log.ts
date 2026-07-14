const sensitive = /prompt|message|output|answer|token|secret|environment/i;
export function safeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !sensitive.test(key)));
}
