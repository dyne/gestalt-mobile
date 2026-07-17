/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
  legacyCopy: (value: string) => boolean = copyWithSelection,
): Promise<boolean> {
  if (!clipboard) return safelyCopy(text, legacyCopy);
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return safelyCopy(text, legacyCopy);
  }
}

function safelyCopy(text: string, legacyCopy: (value: string) => boolean): boolean {
  try {
    return legacyCopy(text);
  } catch {
    return false;
  }
}

function copyWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;opacity:0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  return copied;
}
