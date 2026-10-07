/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileViewer from './FileViewer.svelte';
import type { FileViewerTarget } from './file-preview.js';

describe('shared file viewer line targets', () => {
  let centered: HTMLElement[];
  beforeEach(() => {
    centered = [];
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: {
        configurable: true,
        value: function (this: HTMLDialogElement) {
          this.setAttribute('open', '');
        },
      },
      close: {
        configurable: true,
        value: function (this: HTMLDialogElement) {
          this.removeAttribute('open');
        },
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(function (this: HTMLElement, options: ScrollIntoViewOptions) {
        expect(options.block).toBe('center');
        centered.push(this);
      }),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  function open(
    target: FileViewerTarget,
    content = Array.from({ length: 100 }, (_, i) => `source ${i + 1}`).join('\n'),
  ) {
    const readFile = vi.fn(async (_workspace: string, path: string) => ({
      kind: 'file' as const,
      path,
      content,
      size: content.length,
    }));
    const onerror = vi.fn();
    render(FileViewer, {
      props: { target, readFile, listDirectory: vi.fn(), onclose: vi.fn(), onerror },
    });
    return { readFile, onerror };
  }
  it.each(['app.ts:50', 'app.ts:50:3', 'app.ts#L50C3'])(
    'opens %s at the original line without sending the suffix to the reader',
    async (path) => {
      const { readFile } = open({ workspaceId: 'w', path });
      const highlighted = await screen.findByLabelText('Highlighted line 50');
      expect(highlighted.textContent).toContain('source 50');
      expect(highlighted.classList.contains('highlighted')).toBe(true);
      expect(screen.getByLabelText('File source').textContent).toBe(
        Array.from({ length: 100 }, (_, i) => `source ${i + 1}`).join('\n'),
      );
      expect(readFile).toHaveBeenCalledWith('w', 'app.ts', expect.any(AbortSignal));
      await waitFor(() => expect(centered).toEqual([highlighted]));
    },
  );
  it('accepts explicit line metadata from any viewer caller', async () => {
    open({ workspaceId: 'w', path: 'app.ts', line: 40 });
    await screen.findByLabelText('Highlighted line 40');
    await waitFor(() => expect(centered[0]?.dataset.line).toBe('40'));
  });
  it('uses original JSON lines and retains the target when switching views', async () => {
    open({ workspaceId: 'w', path: 'data.json:3' }, '{\n  "a": [1, 2],\n  "b": true\n}');
    const highlighted = await screen.findByLabelText('Highlighted line 3');
    expect(highlighted.textContent).toContain('"b": true');
    await fireEvent.click(screen.getByRole('button', { name: 'Show formatted' }));
    await screen.findByLabelText('JSON contents');
    await fireEvent.click(screen.getByRole('button', { name: 'Show source' }));
    await screen.findByLabelText('Highlighted line 3');
    await waitFor(() => expect(centered).toHaveLength(2));
  });
  it('keeps formatted Markdown by default and navigates linked line targets with Back', async () => {
    const { readFile } = open(
      { workspaceId: 'w', path: 'docs/readme.md' },
      '# Notes\n\n[Target](../app.ts:3)',
    );
    await screen.findByRole('heading', { name: 'Notes' });
    await fireEvent.click(screen.getByRole('link', { name: 'Target' }));
    await screen.findByLabelText('Highlighted line 3');
    expect(readFile).toHaveBeenLastCalledWith('w', 'docs/../app.ts', expect.any(AbortSignal));
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Notes' });
    expect(screen.queryByLabelText('Highlighted line 3')).toBeNull();
  });
  it('restores a line target after following another file and going Back', async () => {
    open({ workspaceId: 'w', path: 'docs/readme.md:1' }, '# Notes\n\n[Target](../app.ts:3)');
    await screen.findByLabelText('Highlighted line 1');
    await fireEvent.click(screen.getByRole('button', { name: 'Show formatted' }));
    await fireEvent.click(await screen.findByRole('link', { name: 'Target' }));
    await screen.findByLabelText('Highlighted line 3');
    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByLabelText('Highlighted line 1');
    await waitFor(() => expect(centered.at(-1)?.dataset.line).toBe('1'));
  });
  it('does not silently highlight another line for an out-of-range target', async () => {
    open({ workspaceId: 'w', path: 'short.txt:200' }, 'one\ntwo');
    await screen.findByText('Line 200 unavailable (2 lines)');
    expect(document.querySelector('.highlighted')).toBeNull();
    expect(centered).toHaveLength(0);
  });
});
