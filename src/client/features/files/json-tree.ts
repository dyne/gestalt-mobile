/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
export type JsonRow = Readonly<{
  id: string;
  depth: number;
  text: string;
  expandable: boolean;
  expanded: boolean;
  label: string;
  kind: 'string' | 'number' | 'boolean' | 'null' | 'container';
}>;
const children = (value: unknown): [string, unknown][] =>
  value !== null && typeof value === 'object' ? Object.entries(value) : [];
const childId = (id: string, key: string): string => `${id}/${JSON.stringify(key)}`;

export function jsonBranches(value: unknown): Set<string> {
  const result = new Set<string>();
  const pending = [{ value, id: '' }];
  while (pending.length) {
    const item = pending.pop()!;
    const entries = children(item.value);
    if (!entries.length) continue;
    result.add(item.id);
    for (const [key, value] of entries) pending.push({ value, id: childId(item.id, key) });
  }
  return result;
}

/** Iterative projection keeps deeply nested documents off the JavaScript call stack. */
export function jsonRows(value: unknown, expanded: ReadonlySet<string>): JsonRow[] {
  type Pending =
    | { value: unknown; id: string; depth: number; prefix: string; comma: string; label: string }
    | { closing: JsonRow };
  const pending: Pending[] = [
    { value, id: '', depth: 0, prefix: '', comma: '', label: 'JSON root' },
  ];
  const rows: JsonRow[] = [];
  while (pending.length) {
    const item = pending.pop()!;
    if ('closing' in item) {
      rows.push(item.closing);
      continue;
    }
    const entries = children(item.value);
    const container = item.value !== null && typeof item.value === 'object';
    const array = Array.isArray(item.value);
    const open = array ? '[' : '{';
    const close = array ? ']' : '}';
    const isExpanded = entries.length > 0 && expanded.has(item.id);
    rows.push({
      id: item.id,
      depth: item.depth,
      label: item.label,
      expandable: entries.length > 0,
      expanded: isExpanded,
      kind: container
        ? 'container'
        : item.value === null
          ? 'null'
          : (typeof item.value as JsonRow['kind']),
      text:
        item.prefix +
        (container
          ? open +
            (isExpanded
              ? ''
              : entries.length
                ? ` … ${entries.length} ${array ? 'items' : 'keys'} ${close}`
                : close)
          : JSON.stringify(item.value)) +
        (isExpanded ? '' : item.comma),
    });
    if (!isExpanded) continue;
    pending.push({
      closing: {
        id: `${item.id}:close`,
        depth: item.depth,
        text: close + item.comma,
        expandable: false,
        expanded: false,
        label: item.label,
        kind: 'container',
      },
    });
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]!;
      pending.push({
        value: child,
        id: childId(item.id, key),
        depth: item.depth + 1,
        prefix: array ? '' : `${JSON.stringify(key)}: `,
        comma: index < entries.length - 1 ? ',' : '',
        label: `${item.label}${array ? `[${key}]` : `.${key}`}`,
      });
    }
  }
  return rows;
}
