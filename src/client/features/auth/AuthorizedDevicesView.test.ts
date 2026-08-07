/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthorizedDevicesView from './AuthorizedDevicesView.svelte';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const device = (id: string, nickname: string, createdAt: string, current = false) => ({
  id,
  nickname,
  createdAt,
  current,
});
function client(devices = [device('one', '<safe>', '2026-08-02T00:00:00.000Z', true)]) {
  return {
    list: vi.fn(async () => ({ devices })),
    rename: vi.fn(async () => ({})),
    revoke: vi.fn(async () => ({})),
    createTicket: vi.fn(async () => ({
      ticket: 'capability',
      url: 'https://relay.test/#enroll=capability',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    })),
    ticketStatus: vi.fn(async () => ({ status: 'pending' })),
    cancelTicket: vi.fn(async () => ({ status: 'none' })),
  };
}
describe('AuthorizedDevicesView', () => {
  it('orders safe text metadata and provides the impossible-empty fallback', async () => {
    const api = client([
      device('later', '<img src=x>', '2026-08-03T00:00:00.000Z'),
      device('first', 'Phone', '2026-08-01T00:00:00.000Z', true),
    ]);
    const view = render(AuthorizedDevicesView, {
      client: api as never,
      onclose: vi.fn(),
      onlock: vi.fn(),
    });
    await screen.findByDisplayValue('Phone');
    expect(
      [...view.container.querySelectorAll('input[name=nickname]')].map(
        (input) => (input as HTMLInputElement).value,
      ),
    ).toEqual(['Phone', '<img src=x>']);
    expect(view.container.querySelector('img[src="x"]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/credential|capability/);
    cleanup();
    render(AuthorizedDevicesView, {
      client: client([]) as never,
      onclose: vi.fn(),
      onlock: vi.fn(),
    });
    expect(await screen.findByText(/No authorized devices/)).toBeTruthy();
  });

  it('validates Unicode nickname input and leaves a retryable calm error', async () => {
    const api = client();
    api.rename.mockRejectedValueOnce(new Error('offline'));
    render(AuthorizedDevicesView, { client: api as never, onclose: vi.fn(), onlock: vi.fn() });
    const input = await screen.findByLabelText('Nickname for <safe>');
    await fireEvent.input(input, { target: { value: '  🎉 phone  ' } });
    await fireEvent.submit(input.closest('form')!);
    expect(api.rename).toHaveBeenCalledWith('one', '🎉 phone');
    expect(await screen.findByText(/Could not rename/)).toBeTruthy();
    await fireEvent.input(input, { target: { value: ' ' } });
    await fireEvent.submit(input.closest('form')!);
    expect(await screen.findByText(/1–64 characters/)).toBeTruthy();
  });

  it('refreshes the rendered nickname after a successful rename without an error', async () => {
    const api = client([device('one', 'Old phone', '2026-08-02T00:00:00.000Z', true)]);
    api.rename.mockResolvedValueOnce({});
    api.list
      .mockResolvedValueOnce({
        devices: [device('one', 'Old phone', '2026-08-02T00:00:00.000Z', true)],
      })
      .mockResolvedValueOnce({
        devices: [device('one', 'New phone', '2026-08-02T00:00:00.000Z', true)],
      });
    render(AuthorizedDevicesView, { client: api as never, onclose: vi.fn(), onlock: vi.fn() });
    const input = await screen.findByLabelText('Nickname for Old phone');
    await fireEvent.input(input, { target: { value: 'New phone' } });
    await fireEvent.submit(input.closest('form')!);
    expect(await screen.findByDisplayValue('New phone')).toBeTruthy();
    expect(screen.queryByText(/Could not rename/)).toBeNull();
  });

  it('guards the final device and confirms then locks after revoking this device', async () => {
    const only = render(AuthorizedDevicesView, {
      client: client() as never,
      onclose: vi.fn(),
      onlock: vi.fn(),
    });
    expect(
      ((await screen.findByRole('button', { name: 'Revoke' })) as HTMLButtonElement).disabled,
    ).toBe(true);
    cleanup();
    const api = client([
      device('one', 'Current', '2026-08-01T00:00:00.000Z', true),
      device('two', 'Other', '2026-08-02T00:00:00.000Z'),
    ]);
    const onlock = vi.fn();
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    render(AuthorizedDevicesView, { client: api as never, onclose: vi.fn(), onlock });
    const revoke = await screen.findAllByRole('button', { name: 'Revoke' });
    await fireEvent.click(revoke[0]!);
    expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBe('revoke-title');
    expect(screen.getByText('Revoke authorized device?')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }));
    expect(api.revoke).toHaveBeenCalledWith('one');
    expect(onlock).toHaveBeenCalledOnce();
    void only;
  });

  it('creates equivalent QR/link enrollment, replaces or cancels it, and tears polling down', async () => {
    vi.useFakeTimers();
    const api = client();
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const create = vi.fn();
    render(AuthorizedDevicesView, {
      client: api as never,
      onclose: vi.fn(),
      onlock: vi.fn(),
      oncreatepasskey: create,
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Create enrollment link' }));
    const link = await screen.findByLabelText('Enrollment link');
    expect((link as HTMLInputElement).value).toBe('https://relay.test/#enroll=capability');
    expect(
      (await screen.findByRole('img', { name: 'QR code for the enrollment link' })).getAttribute(
        'src',
      ),
    ).toMatch(/^data:image/);
    await fireEvent.click(screen.getByRole('button', { name: 'Create passkey here' }));
    expect(create).toHaveBeenCalledWith('capability');
    await fireEvent.click(screen.getByRole('button', { name: 'Replace link' }));
    expect(api.cancelTicket).toHaveBeenCalled();
    expect(api.createTicket).toHaveBeenCalledTimes(2);
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel link' }));
    expect(clear).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
