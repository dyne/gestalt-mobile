/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';

/** No app bytes, external assets, storage, query redirects, or grant-only fallback. */
export function exchangeDocument(mobileOrigin: string): { html: string; csp: string } {
  const mobile = JSON.stringify(new URL(mobileOrigin).origin);
  const script = `(() => {
  const mobileOrigin = ${mobile};
  const peer = window.opener;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const validFragment = fragment.getAll('grant').length === 1 && fragment.getAll('grantId').length === 1 &&
    [...fragment.keys()].every((key) => key === 'grant' || key === 'grantId');
  let grant = fragment.get('grant');
  const grantId = fragment.get('grantId');
  fragment.delete('grant');
  history.replaceState(null, '', '/__gestalt_live/auth');
  const status = document.getElementById('status');
  let finished = false;
  let verifier = null;
  const controller = new AbortController();
  const stop = () => {
    finished = true; grant = null; verifier = null;
    controller.abort();
    window.removeEventListener('message', receive);
    window.opener = null;
    status.textContent = 'Reopen from Mobile';
  };
  const timer = setTimeout(stop, 60000);
  const receive = async (event) => {
    if (finished || event.origin !== mobileOrigin || event.source !== peer) return;
    const value = event.data;
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'codeVerifier,grantId,type' ||
        value.type !== 'gestalt-live-proof' || value.grantId !== grantId ||
        typeof value.codeVerifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.codeVerifier)) return;
    finished = true;
    window.removeEventListener('message', receive);
    verifier = value.codeVerifier;
    try {
      const response = await fetch('/__gestalt_live/exchange', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantId, grant, codeVerifier: verifier }),
        signal: controller.signal
      });
      grant = null; verifier = null;
      if (!response.ok) throw new Error('exchange');
      if (window.opener !== peer) throw new Error('opener');
      peer.postMessage({ type: 'gestalt-live-exchanged', grantId }, mobileOrigin);
      clearTimeout(timer);
      window.opener = null;
      location.replace('/');
    } catch { clearTimeout(timer); stop(); }
  };
  if (!validFragment || !peer || !grant || !/^[A-Za-z0-9_-]{43}$/.test(grant) || !grantId || !/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) {
    clearTimeout(timer); stop(); return;
  }
  window.addEventListener('message', receive);
  peer.postMessage({ type: 'gestalt-live-proof', grantId }, mobileOrigin);
})();`;
  const hash = createHash('sha256').update(script).digest('base64');
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Open Live preview</title></head><body><p id="status">Opening Live preview…</p><script>${script}</script></body></html>`,
    csp: `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  };
}
