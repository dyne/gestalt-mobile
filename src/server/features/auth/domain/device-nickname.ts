/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { AuthorizationDomainError } from './errors.js';

declare const deviceNicknameBrand: unique symbol;
export type DeviceNickname = string & { readonly [deviceNicknameBrand]: 'DeviceNickname' };

export function deviceNickname(value: string): DeviceNickname {
  const normalized = Array.from(value.trim()).join('');
  const length = Array.from(normalized).length;
  if (length < 1 || length > 64) throw new AuthorizationDomainError('DEVICE_NICKNAME_INVALID');
  return normalized as DeviceNickname;
}
