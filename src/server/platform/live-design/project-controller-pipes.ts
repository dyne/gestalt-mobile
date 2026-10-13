/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Takes exclusive ownership of both FIFO descriptors. Raw callers must never close them again. */
export class ProjectControllerPipes {
  readonly input: ReturnType<typeof createWriteStream>;
  readonly output: ReturnType<typeof createReadStream>;
  readonly lines: ReturnType<typeof createInterface>;
  private readonly inputClosed: Promise<void>;
  private readonly outputClosed: Promise<void>;
  private readonly errors = new Set<string>();
  private closing?: Promise<void>;

  constructor(
    inputDescriptor: number,
    outputDescriptor: number,
    onFailure: (code: string) => void,
  ) {
    // Explicit destroy closes an fs stream even with autoClose:false. These streams own the FDs.
    this.input = createWriteStream('', { fd: inputDescriptor, autoClose: true });
    this.output = createReadStream('', { fd: outputDescriptor, autoClose: true });
    this.inputClosed = new Promise((resolve) => this.input.once('close', resolve));
    this.outputClosed = new Promise((resolve) => this.output.once('close', resolve));
    const failed = (error: unknown) => {
      const rawCode = (error as NodeJS.ErrnoException).code;
      const code = ['EBADF', 'EPIPE', 'EIO', 'EINVAL'].includes(rawCode ?? '')
        ? rawCode!
        : 'UNCLASSIFIED';
      this.errors.add(code);
      onFailure(code);
    };
    this.input.on('error', failed);
    this.output.on('error', failed);
    this.lines = createInterface({ input: this.output, crlfDelay: Infinity });
    // readline forwards ReadStream errors onto Interface. Both event owners need a handler.
    this.lines.on('error', failed);
  }
  errorCodes(): readonly string[] {
    return [...this.errors].sort();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.lines.close();
      this.input.destroy();
      this.output.destroy();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([this.inputClosed, this.outputClosed]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('LIVE_PROJECT_PIPE_CLOSE_TIMEOUT')), 5000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // Disconnect is an operational failure; EBADF is an ownership violation, never hidden.
      if ([...this.errors].some((code) => code !== 'EPIPE'))
        throw new Error('LIVE_PROJECT_PIPE_CLOSE_FAILED');
    })();
    return this.closing;
  }
}
