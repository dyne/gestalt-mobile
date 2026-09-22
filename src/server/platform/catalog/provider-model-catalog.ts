/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { LlmProvider } from '../../../shared/contracts/llm-provider.js';
import type { ModelCatalog } from '../../features/catalog/application/ports.js';

/** A single provider's model list before the provider-aware port is applied. */
export interface SingleProviderModelCatalog {
  list(): Promise<string[]>;
}

/** Routes each provider's model query to that provider's own catalog adapter. */
export class ProviderModelCatalog implements ModelCatalog {
  public constructor(
    private readonly catalogs: Readonly<Record<LlmProvider, SingleProviderModelCatalog>>,
  ) {}

  list(provider: LlmProvider): Promise<string[]> {
    return this.catalogs[provider].list();
  }
}
