export async function loadBootstrap(fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher('/api/bootstrap');
  if (!response.ok) throw new Error('BOOTSTRAP_FAILED');
  return response.json();
}
