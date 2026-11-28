/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PreviewConfig } from '../../config.js';
import type { PreviewService } from '../../features/previews/application/service.js';
import { createPreviewGateway } from './gateway.js';
import type { ImpeccableHelper } from './impeccable.js';

export class PreviewPublication {
  private current?: { config: PreviewConfig; gateway: ReturnType<typeof createPreviewGateway> };
  private pending?: Promise<string | undefined>;
  private closing = false;

  constructor(
    private readonly service: PreviewService,
    private readonly load: () => Promise<PreviewConfig | undefined>,
    private readonly impeccableHelper: (id: string) => Promise<ImpeccableHelper | undefined>,
  ) {}

  async start(config: PreviewConfig): Promise<string> {
    const gateway = createPreviewGateway(
      { ...config, impeccableHelper: this.impeccableHelper },
      this.service,
    );
    await gateway.start();
    this.current = { config, gateway };
    return config.origin;
  }

  refresh(): Promise<string | undefined> {
    if (this.closing) return Promise.resolve(undefined);
    this.pending ??= this.apply().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async apply(): Promise<string | undefined> {
    const config = await this.load().catch(() => undefined);
    if (this.closing) return;
    const previous = this.current?.config;
    if (
      config &&
      previous?.origin === config.origin &&
      previous.port === config.port &&
      previous.targetPort === config.targetPort
    )
      return previous.origin;
    await this.withdraw();
    if (config && !this.closing) return this.start(config).catch(() => undefined);
  }

  private async withdraw(): Promise<void> {
    const previous = this.current;
    this.current = undefined;
    this.service.clear();
    await previous?.gateway.close();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.pending;
    await this.withdraw();
  }
}
