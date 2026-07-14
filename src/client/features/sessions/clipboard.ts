export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> = navigator.clipboard,
): Promise<boolean> {
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
