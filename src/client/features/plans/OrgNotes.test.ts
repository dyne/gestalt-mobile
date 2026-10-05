/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import OrgNotes from './OrgNotes.svelte';
import { parseOrgDocument } from './org-document.js';
afterEach(cleanup);
it('preserves Notes line breaks and activates file references as safe local links', async () => {
  const onreference = vi.fn();
  const { container } = render(OrgNotes, {
    text: 'First =dir with spaces/file.md=\nSecond =javascript:alert(1)=',
    onreference,
  });
  expect(container.textContent).toBe('First dir with spaces/file.md\nSecond javascript:alert(1)');
  const link = screen.getByRole('link', { name: 'dir with spaces/file.md' });
  expect(link.getAttribute('href')).toMatch(/^#file-preview=/);
  await fireEvent.click(link);
  expect(onreference).toHaveBeenCalledWith('dir with spaces/file.md');
  expect(
    screen.getByRole('link', { name: 'javascript:alert(1)' }).getAttribute('href'),
  ).not.toMatch(/^javascript:/);
});
it('retains raw Org Notes continuation lines and blank lines', () => {
  const result = parseOrgDocument(
    '* TODO Task\n- Notes :: First =a=\n  Second\n\n  Fourth\n- Goal :: Separate',
  );
  expect(result.sections[0]?.descriptions).toEqual([
    ['Notes', 'First =a=\nSecond\n\nFourth'],
    ['Goal', 'Separate'],
  ]);
});
