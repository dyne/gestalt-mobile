/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startRegistration, bootstrapQrDataUrl } = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  bootstrapQrDataUrl: vi.fn(async () => 'data:image/png;base64,qr'),
}));
vi.mock('@simplewebauthn/browser', () => ({ startRegistration }));
vi.mock('./qr-link.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./qr-link.js')>()),
  bootstrapQrDataUrl,
}));

import FirstDeviceEnrollment from './FirstDeviceEnrollment.svelte';

type TestClient = {
  status: ReturnType<typeof vi.fn>;
  registrationOptions: ReturnType<typeof vi.fn>;
  verifyRegistration: ReturnType<typeof vi.fn>;
};

function props(
  overrides: Partial<{
    client: TestClient;
    canonicalOrigin: string;
    onAuthenticated: ReturnType<typeof vi.fn>;
    onLocked: ReturnType<typeof vi.fn>;
    enrollmentTicket: string;
  }> = {},
) {
  const client: TestClient = {
    status: vi.fn(async () => ({ status: 'bootstrap', publicOrigin: 'https://relay.example' })),
    registrationOptions: vi.fn(async () => ({ options: { challenge: 'challenge' } })),
    verifyRegistration: vi.fn(async () => ({ status: 'authenticated' })),
  };
  return {
    client,
    canonicalOrigin: 'https://relay.example',
    onAuthenticated: vi.fn(),
    onLocked: vi.fn(),
    ...overrides,
  };
}

function mount(values: ReturnType<typeof props>) {
  return render(FirstDeviceEnrollment, values as never);
}

describe('FirstDeviceEnrollment', () => {
  beforeEach(() => {
    startRegistration.mockReset();
    startRegistration.mockResolvedValue({ id: 'credential' });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(window, 'PublicKeyCredential', { configurable: true, value: class {} });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    window.matchMedia = vi.fn(() => ({ matches: false })) as never;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows unsupported state without starting a ceremony', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    mount(props());
    expect(
      (screen.getByRole('button', { name: 'Authorize this device' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('Passkeys require a secure browser on this device.')).toBeTruthy();
  });

  it('requires a trimmed nickname and sends the trimmed value after explicit authorization', async () => {
    const input = () => screen.getByLabelText('Device nickname');
    const values = props();
    mount(values);
    await fireEvent.click(screen.getByRole('button', { name: 'Authorize this device' }));
    expect(screen.getByText('Enter a device nickname before authorizing it.')).toBeTruthy();
    await fireEvent.input(input(), { target: { value: '  Desk  ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Authorize this device' }));
    await vi.waitFor(() =>
      expect(values.client.verifyRegistration).toHaveBeenCalledWith({ id: 'credential' }, 'Desk'),
    );
    expect(values.onAuthenticated).toHaveBeenCalledOnce();
  });

  it('suppresses duplicate authorization clicks while a ceremony is in flight', async () => {
    let resolveOptions!: (value: { options: { challenge: string } }) => void;
    const values = props({
      client: {
        ...props().client,
        registrationOptions: vi.fn(() => new Promise((resolve) => (resolveOptions = resolve))),
      },
    });
    mount(values);
    await fireEvent.input(screen.getByLabelText('Device nickname'), { target: { value: 'Desk' } });
    const button = screen.getByRole('button', { name: 'Authorize this device' });
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(values.client.registrationOptions).toHaveBeenCalledOnce();
    resolveOptions({ options: { challenge: 'challenge' } });
  });

  it.each(['NotAllowedError', 'InvalidStateError'] as const)(
    'keeps nickname after %s',
    async (name) => {
      startRegistration.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { name }));
      mount(props());
      await fireEvent.input(screen.getByLabelText('Device nickname'), {
        target: { value: 'Phone' },
      });
      await fireEvent.click(screen.getByRole('button', { name: 'Authorize this device' }));
      await vi.waitFor(() =>
        expect(screen.getByText(/passkey request was cancelled|already registered/i)).toBeTruthy(),
      );
      expect((screen.getByLabelText('Device nickname') as HTMLInputElement).value).toBe('Phone');
    },
  );

  it('locks safely when another device wins the bootstrap race', async () => {
    const values = props({
      client: {
        ...props().client,
        verifyRegistration: vi.fn(async () => {
          throw new Error('AUTH_REQUEST_FAILED_409');
        }),
      },
    });
    mount(values);
    await fireEvent.input(screen.getByLabelText('Device nickname'), { target: { value: 'Phone' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Authorize this device' }));
    await vi.waitFor(() =>
      expect(values.onLocked).toHaveBeenCalledWith(expect.stringMatching(/another device/i)),
    );
  });

  it('uses the exact useful link as the QR input and visible fallback', async () => {
    mount(props());
    const link = screen.getByRole('link');
    expect(link.textContent).toBe('https://relay.example/?bootstrap=1');
    expect(link.getAttribute('href')).toBe('https://relay.example/?bootstrap=1');
    await vi.waitFor(() =>
      expect(bootstrapQrDataUrl).toHaveBeenCalledWith('https://relay.example'),
    );
  });

  it('keeps the text-link fallback when QR creation fails', async () => {
    bootstrapQrDataUrl.mockRejectedValueOnce(new Error('QR unavailable'));
    mount(props());
    await vi.waitFor(() =>
      expect(screen.getByText('Setup QR unavailable. Use the setup link below.')).toBeTruthy(),
    );
    expect(screen.getByRole('link').textContent).toBe('https://relay.example/?bootstrap=1');
  });

  it('does not claim success when clipboard copying is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    mount(props());
    await fireEvent.click(screen.getByRole('button', { name: 'Copy setup link' }));
    expect(
      screen.getByText('Copy is unavailable here. Select and copy the visible setup link.'),
    ).toBeTruthy();
  });

  it('polls only while visible on desktop and cleans up when unmounted', async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn(() => ({ matches: true })) as never;
    const values = props();
    const view = mount(values);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(values.client.status).toHaveBeenCalledOnce();
    view.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(values.client.status).toHaveBeenCalledOnce();
  });

  it('does not poll while the document is hidden', async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn(() => ({ matches: true })) as never;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const values = props();
    mount(values);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(values.client.status).not.toHaveBeenCalled();
  });

  it('does not cancel ticket enrollment when an existing relay is locked on desktop', async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn(() => ({ matches: true })) as never;
    const values = props({
      enrollmentTicket: 'ticket',
      client: {
        ...props().client,
        status: vi.fn(async () => ({ status: 'locked', publicOrigin: 'https://relay.example' })),
      },
    });
    mount(values);
    await fireEvent.input(screen.getByLabelText('Device nickname'), { target: { value: 'Omni' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Authorize this device' }));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() =>
      expect(values.client.verifyRegistration).toHaveBeenCalledWith({ id: 'credential' }, 'Omni'),
    );
    expect(values.client.status).not.toHaveBeenCalled();
    expect(values.onLocked).not.toHaveBeenCalled();
    expect(values.onAuthenticated).toHaveBeenCalledOnce();
  });

  it('does not continue an in-flight registration after another device wins polling', async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn(() => ({ matches: true })) as never;
    let resolveOptions!: (value: { options: { challenge: string } }) => void;
    const values = props({
      client: {
        ...props().client,
        status: vi.fn(async () => ({ status: 'locked', publicOrigin: 'https://relay.example' })),
        registrationOptions: vi.fn(() => new Promise((resolve) => (resolveOptions = resolve))),
      },
    });
    mount(values);
    await fireEvent.input(screen.getByLabelText('Device nickname'), { target: { value: 'Desk' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Authorize this device' }));
    await vi.waitFor(() => expect(values.client.registrationOptions).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(values.onLocked).toHaveBeenCalledOnce());
    resolveOptions({ options: { challenge: 'challenge' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(startRegistration).not.toHaveBeenCalled();
    expect(values.client.verifyRegistration).not.toHaveBeenCalled();
  });
});
