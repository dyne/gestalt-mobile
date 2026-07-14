type RandomUUIDProvider = { randomUUID?: () => string };

export function createIdempotencyKey(
  cryptoApi: RandomUUIDProvider | undefined = globalThis.crypto,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `k-${now().toString(36)}-${Math.floor(random() * 0x100000000).toString(36)}`;
}
