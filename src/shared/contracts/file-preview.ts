/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type PreviewImageType = 'image/png' | 'image/jpeg';

export type FilePreview = Readonly<
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; content: string; size: number; hasUtf8Bom?: true }
  | { kind: 'image'; path: string; mediaType: PreviewImageType; base64: string; size: number }
>;
