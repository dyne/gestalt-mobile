/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LiveClient, LiveRun } from './contracts.js';

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** Reserve the window in the user gesture. Secrets stay in memory and the fragment. */
export function openPreview(
  client: LiveClient,
  relayId: string,
  run: LiveRun,
  failed: (message: string) => void,
): { opened: boolean; dispose: () => void } {
  let peer: Window | null;
  try {
    peer = window.open('about:blank', '_blank');
  } catch {
    peer = null;
  }
  if (!peer) return { opened: false, dispose: () => {} };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let receive: ((event: MessageEvent) => void) | undefined;
  let verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const dispose = () => {
    disposed = true;
    verifier = '';
    clearTimeout(timer);
    if (receive) window.removeEventListener('message', receive);
    window.removeEventListener('pagehide', dispose);
  };
  window.addEventListener('pagehide', dispose, { once: true });
  void (async () => {
    try {
      const codeChallenge = base64url(
        new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
      );
      if (disposed) return;
      const grant = await client.liveLaunch(relayId, { ...run, codeChallenge });
      if (disposed) return;
      const origin = new URL(grant.previewOrigin);
      if (
        origin.protocol !== 'https:' ||
        origin.origin !== grant.previewOrigin ||
        origin.hostname === location.hostname ||
        !/^[A-Za-z0-9_-]{43}$/.test(grant.grant) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(grant.grantId)
      )
        throw new Error('invalid grant');
      receive = (event) => {
        if (disposed || event.source !== peer || event.origin !== origin.origin) return;
        const value = event.data;
        if (
          !value ||
          Object.keys(value).sort().join(',') !== 'grantId,type' ||
          value.grantId !== grant.grantId
        )
          return;
        if (value.type === 'gestalt-live-proof') {
          peer.postMessage(
            { type: 'gestalt-live-proof', grantId: grant.grantId, codeVerifier: verifier },
            origin.origin,
          );
        } else if (value.type === 'gestalt-live-exchanged') dispose();
      };
      window.addEventListener('message', receive);
      timer = setTimeout(() => {
        dispose();
        failed('Live preview access expired. Choose Open preview to try again.');
      }, 60_000);
      peer.location.replace(
        `${origin.origin}/__gestalt_live/auth#grant=${grant.grant}&grantId=${grant.grantId}`,
      );
    } catch {
      if (!disposed) {
        dispose();
        peer.close();
        failed('Could not open Live preview. Choose Open preview to try again.');
      }
    }
  })();
  return { opened: true, dispose };
}
