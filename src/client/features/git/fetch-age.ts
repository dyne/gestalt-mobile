export function fetchAge(fetchedAt: string | null, now = Date.now()): string {
  if (!fetchedAt) return 'Not fetched yet';
  const elapsed = Math.max(0, now - new Date(fetchedAt).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Fetched just now';
  if (minutes < 60) return `Fetched ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Fetched ${hours}h ago`;
  return `Fetched ${Math.floor(hours / 24)}d ago`;
}
