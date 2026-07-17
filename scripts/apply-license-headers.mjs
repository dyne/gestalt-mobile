/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { applySourceHeaders, repositorySourceFiles } from './license-headers.mjs';

applySourceHeaders(repositorySourceFiles());
