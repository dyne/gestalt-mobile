/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Duplex } from 'node:stream';
import { ConnectionFileVerification } from './process-identity.js';
import type { PreviewInstance } from '../../features/live-design/application/ports.js';
import type { IsolatedProjectProcess, IsolatedProjectReceipt } from './isolated-project-process.js';

export interface PreviewUpstreams {
  /** Fixed admitted resource only. A URL, port, command or PID is never supplied by a request. */
  open(role: 'app' | 'helper'): Duplex | Promise<Duplex>;
}

/** One owning generation's actual process handles and protected receipts. No process adoption. */
export function isolatedPreviewUpstreams(input: {
  instance: PreviewInstance;
  appRoot: string;
  helper: { process: IsolatedProjectProcess; receipt: IsolatedProjectReceipt };
  devserver: { process: IsolatedProjectProcess; receipt: IsolatedProjectReceipt };
}): PreviewUpstreams {
  const instance = structuredClone(input.instance);
  const appRoot = input.appRoot;
  // Do not let a later caller mutate a receipt into another owning session/generation.
  const helper = { process: input.helper.process, receipt: structuredClone(input.helper.receipt) };
  const devserver = {
    process: input.devserver.process,
    receipt: structuredClone(input.devserver.receipt),
  };
  const bindings = () => {
    if (
      helper.process === devserver.process ||
      helper.receipt.role !== 'helper' ||
      devserver.receipt.role !== 'devserver' ||
      [helper.receipt, devserver.receipt].some(
        (receipt) =>
          receipt.sessionId !== instance.relayId ||
          receipt.generation !== instance.generation ||
          receipt.target.cwd !== appRoot ||
          receipt.network !== 'private-loopback-only',
      ) ||
      helper.receipt.target.namespaces.net === devserver.receipt.target.namespaces.net
    )
      throw new Error('LIVE_PREVIEW_PROCESS_UNAVAILABLE');
  };
  bindings();
  helper.process.verify(helper.receipt);
  devserver.process.verify(devserver.receipt);
  return {
    async open(role) {
      // Revalidate BOTH resources before every HTTP/SSE/HMR connection; a changed
      // helper must revoke the app's browser authority too. Never fall back to TCP.
      bindings();
      const cancellation = new AbortController();
      const files = new ConnectionFileVerification();
      try {
        const [helperReady, appReady] = await Promise.all([
          helper.process.prepareConnection(helper.receipt, cancellation.signal, files),
          devserver.process.prepareConnection(devserver.receipt, cancellation.signal, files),
        ]);
        helperReady.assertCurrent();
        appReady.assertCurrent();
        return (role === 'app' ? appReady : helperReady).open();
      } catch (error) {
        cancellation.abort();
        throw error;
      } finally {
        files.close();
      }
    },
  };
}
