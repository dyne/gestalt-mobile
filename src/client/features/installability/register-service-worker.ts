/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

interface InstallabilityBrowser {
  readyState: DocumentReadyState;
  addLoadListener(listener: () => void): void;
  serviceWorker?: Pick<ServiceWorkerContainer, 'register'>;
}

function currentBrowser(): InstallabilityBrowser {
  return {
    readyState: document.readyState,
    addLoadListener: (listener) => window.addEventListener('load', listener, { once: true }),
    serviceWorker: navigator.serviceWorker,
  };
}

export function registerInstallabilityWorker(
  browser: InstallabilityBrowser = currentBrowser(),
): void {
  if (!browser.serviceWorker) return;

  const register = (): void => {
    void browser.serviceWorker
      ?.register('/service-worker.js', { scope: '/' })
      .catch(() => undefined);
  };

  if (browser.readyState === 'complete') {
    register();
    return;
  }

  browser.addLoadListener(register);
}
