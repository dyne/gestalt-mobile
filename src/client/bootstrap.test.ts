/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { mountClient } from './bootstrap.js';

describe('client bootstrap', () => {
  it('scrubs an enrollment fragment before mounting code that can begin the first fetch', () => {
    const order: string[] = [];
    const history = { state: null, replaceState: () => order.push('scrub') } as unknown as History;
    const mountApp = (
      _component: unknown,
      options: { props?: { enrollmentTicket?: string; initialTheme?: string } },
    ) => {
      order.push('mount');
      expect(options.props?.enrollmentTicket).toBe('opaque-ticket');
      expect(options.props?.initialTheme).toBe('dyne-org');
      return {} as never;
    };
    mountClient(
      document.createElement('div'),
      { hash: '#enroll=opaque-ticket', pathname: '/', search: '' } as Location,
      history,
      mountApp as never,
    );
    expect(order).toEqual(['scrub', 'mount']);
  });

  it('applies the selected theme after fragment scrubbing and before mounting', () => {
    const order: string[] = [];
    const root = document.createElement('html');
    mountClient(
      document.createElement('div'),
      { hash: '#enroll=opaque-ticket', pathname: '/', search: '' } as Location,
      { state: null, replaceState: () => order.push('scrub') } as unknown as History,
      ((_component: unknown, options: { props?: { initialTheme?: string } }) => {
        order.push('mount');
        expect(options.props?.initialTheme).toBe('minimal-dark');
        expect(root.dataset.theme).toBe('minimal-dark');
        return {} as never;
      }) as never,
      { root, meta: null, storage: { getItem: () => 'minimal-dark', setItem: () => {} } },
    );
    expect(order).toEqual(['scrub', 'mount']);
  });

  it('also scrubs malformed enrollment fragments before mounting', () => {
    const order: string[] = [];
    const history = { state: null, replaceState: () => order.push('scrub') } as unknown as History;
    mountClient(
      document.createElement('div'),
      { hash: '#enroll=%E0%A4%A', pathname: '/', search: '' } as Location,
      history,
      ((_component: unknown, options: { props?: { enrollmentTicket?: string } }) => {
        order.push('mount');
        expect(options.props?.enrollmentTicket).toBeUndefined();
        return {} as never;
      }) as never,
    );
    expect(order).toEqual(['scrub', 'mount']);
  });
});
