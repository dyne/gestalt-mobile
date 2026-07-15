export type HistoryActivity = {
  id: string;
  label: string;
  detail: string;
};

export function toActivity(item: Record<string, unknown>): HistoryActivity | null {
  if (typeof item.id !== 'string') return null;
  if (item.kind === 'reasoning' && Array.isArray(item.summary)) {
    const detail = item.summary
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    return detail ? { id: item.id, label: 'Reasoning summary', detail } : null;
  }
  if (item.kind === 'plan' && typeof item.text === 'string')
    return { id: item.id, label: 'Plan', detail: item.text };
  if (item.kind === 'command' && typeof item.command === 'string')
    return {
      id: item.id,
      label: `Command · ${String(item.status ?? 'unknown')}`,
      detail: item.command,
    };
  if (item.kind === 'fileChange' && Array.isArray(item.paths))
    return {
      id: item.id,
      label: `File change · ${String(item.status ?? 'unknown')}`,
      detail: item.paths.join('\n'),
    };
  if (item.kind === 'tool' && typeof item.name === 'string')
    return { id: item.id, label: `Tool · ${String(item.status ?? 'unknown')}`, detail: item.name };
  return null;
}
