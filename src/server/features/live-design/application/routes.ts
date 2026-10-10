/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Registration IDs come from the controller, never a browser-supplied proxy URL. */
export interface LivePreviewRoutes {
  activate(canonicalAppRoot: string, registrationId: string): Promise<PreviewOriginAssignment>;
  remove(canonicalAppRoot: string): Promise<void>;
  reconcile(): Promise<void>;
}
export type PreviewOriginAssignment = {
  canonicalAppRoot: string;
  origin: string;
  port: number;
  serverId: string;
};
