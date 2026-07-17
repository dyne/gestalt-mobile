/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ProblemDetail = {
  type: `urn:gestalt-mobile:error:${string}`;
  title: string;
  status: number;
  detail: string;
  code: string;
  retryable: boolean;
  fieldErrors?: Record<string, string[]>;
};
