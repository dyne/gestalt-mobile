/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export class AuthorizationDomainError extends Error {}

/**
 * A finite persistent ceremony pool prevents abandoned browser attempts from
 * indefinitely consuming local authorization state.  Endpoints intentionally
 * map this to their existing non-enumerating failure response.
 */
export class CeremonyCapacityError extends AuthorizationDomainError {}
