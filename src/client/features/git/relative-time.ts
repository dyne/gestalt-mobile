export function ageLabel(ageMilliseconds: number): string {
  const minutes = Math.floor(ageMilliseconds / 60_000);
  return minutes < 1 ? 'just now' : `${minutes}m ago`;
}
