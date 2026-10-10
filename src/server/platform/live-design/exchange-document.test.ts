/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { exchangeDocument } from './exchange-document.js';

const mobile = 'https://mobile.example.test';
const preview = 'https://preview.example.test:9443';
const grant = 'a'.repeat(43);
const verifier = 'b'.repeat(43);
function harness(options: { opener?: boolean; hash?: string; success?: boolean } = {}) {
  const messages: { data: unknown; target: string }[] = [];
  const history: string[] = [];
  const navigations: string[] = [];
  const requests: { url: string; options: { body: string; credentials: string; cache: string } }[] =
    [];
  let callback:
    ((event: { origin: string; source: unknown; data: unknown }) => Promise<void>) | undefined;
  let timeout: (() => void) | undefined;
  const peer = { postMessage: (data: unknown, target: string) => messages.push({ data, target }) };
  const window = {
    opener: options.opener === false ? null : peer,
    addEventListener: (_type: string, handler: typeof callback) => {
      callback = handler;
    },
    removeEventListener: () => {
      callback = undefined;
    },
  };
  const status = { textContent: '' };
  const page = exchangeDocument(mobile);
  const script = page.html.match(/<script>([\s\S]*)<\/script>/)![1]!;
  runInNewContext(script, {
    window,
    URLSearchParams,
    AbortController,
    location: {
      hash: options.hash ?? `#grant=${grant}&grantId=grant-id`,
      replace: (path: string) => navigations.push(path),
    },
    history: {
      replaceState: (_state: unknown, _unused: string, path: string) => history.push(path),
    },
    document: { getElementById: () => status },
    setTimeout: (handler: () => void) => {
      timeout = handler;
      return 1;
    },
    clearTimeout: () => {
      timeout = undefined;
    },
    fetch: async (url: string, request: (typeof requests)[number]['options']) => {
      requests.push({ url, options: request });
      return { ok: options.success !== false };
    },
  });
  return {
    page,
    script,
    peer,
    window,
    history,
    messages,
    requests,
    navigations,
    status,
    send: async (data: unknown, origin = mobile, source: unknown = peer) => {
      await callback?.({ origin, source, data });
    },
    timeout: () => timeout?.(),
  };
}

describe('exchange document proof handoff', () => {
  it('pins the exact script, uses no external assets or unsafe CSP, removes fragments before proof handoff', () => {
    const h = harness();
    expect(h.page.csp).toBe(
      `default-src 'none'; script-src 'sha256-${createHash('sha256').update(h.script).digest('base64')}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    );
    expect(h.page.html).not.toMatch(/(?:src|href)=/);
    expect(h.history).toEqual(['/__gestalt_live/auth']);
    expect(h.messages).toEqual([
      { data: { type: 'gestalt-live-proof', grantId: 'grant-id' }, target: mobile },
    ]);
    expect(JSON.stringify(h.messages)).not.toContain(grant);
  });
  it('accepts exactly one matching proof from the Mobile opener and severs it before fixed navigation', async () => {
    const h = harness();
    const proof = { type: 'gestalt-live-proof', grantId: 'grant-id', codeVerifier: verifier };
    await h.send(proof, preview);
    await h.send(proof, mobile, {});
    await h.send({ ...proof, grantId: 'other' });
    await h.send({ ...proof, unexpected: true });
    expect(h.requests).toHaveLength(0);
    await h.send(proof);
    await h.send(proof);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.url).toBe('/__gestalt_live/exchange');
    expect(JSON.parse(h.requests[0]!.options.body)).toEqual({
      grantId: 'grant-id',
      grant,
      codeVerifier: verifier,
    });
    expect(h.requests[0]!.options.credentials).toBe('same-origin');
    expect(h.requests[0]!.options.cache).toBe('no-store');
    expect(h.messages[1]).toEqual({
      data: { type: 'gestalt-live-exchanged', grantId: 'grant-id' },
      target: mobile,
    });
    expect(h.window.opener).toBeNull();
    expect(h.navigations).toEqual(['/']);
  });
  it.each([
    { opener: false },
    { hash: `#grant=${grant}&grantId=grant-id&returnTo=//attacker.test` },
    { hash: '#grant=invalid' },
  ])('fails without an opener or for unsafe fragments: %j', async (options) => {
    const h = harness(options);
    await h.send({ type: 'gestalt-live-proof', grantId: 'grant-id', codeVerifier: verifier });
    expect(h.status.textContent).toBe('Reopen from Mobile');
    expect(h.window.opener).toBeNull();
    expect(h.requests).toHaveLength(0);
    expect(h.navigations).toHaveLength(0);
  });
  it('expires safely and ignores late proof; failure never navigates to app content', async () => {
    const expired = harness();
    expired.timeout();
    await expired.send({ type: 'gestalt-live-proof', grantId: 'grant-id', codeVerifier: verifier });
    expect(expired.requests).toHaveLength(0);
    const failed = harness({ success: false });
    await failed.send({ type: 'gestalt-live-proof', grantId: 'grant-id', codeVerifier: verifier });
    expect(failed.navigations).toHaveLength(0);
    expect(failed.status.textContent).toBe('Reopen from Mobile');
    expect(failed.window.opener).toBeNull();
  });
});
