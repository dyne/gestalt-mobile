/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

process.env.GESTALT_COMPOSITION_CONCERN = 'lifecycle';
await import('./composition.contracts.js');

export {};
