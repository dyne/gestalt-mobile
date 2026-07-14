export type Tab = 'chat' | 'git' | 'sessions';
export function nextTab(current: Tab, direction: 1 | -1): Tab {
  const tabs: Tab[] = ['chat', 'git', 'sessions'];
  return tabs[(tabs.indexOf(current) + direction + tabs.length) % tabs.length]!;
}
