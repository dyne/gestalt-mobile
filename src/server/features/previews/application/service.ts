/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AuthorizationSessionId } from '../../auth/domain/identifiers.js';

const codeLifetime = 30_000;
export const previewSessionLifetime = 60 * 60;
const grantLimit = 128;

export type PreviewMode = 'view' | 'impeccable';
type Grant = { login: AuthorizationSessionId; expiresAt: number; mode: PreviewMode };
type Preview = {
  sessionId: string;
  codes: Map<string, Grant>;
  viewers: Map<string, Grant>;
};

export class PreviewService {
  private preview: Preview | undefined;

  constructor(
    private readonly deps: {
      sessionActive(id: string): boolean;
      loginValid(id: AuthorizationSessionId): boolean;
      now(): number;
      token(): string;
    },
  ) {}

  open(sessionId: string, login: AuthorizationSessionId, mode: PreviewMode = 'view') {
    const current = this.activePreview();
    if (!this.deps.sessionActive(sessionId)) return { kind: 'inactive' } as const;
    if (!this.deps.loginValid(login)) return { kind: 'unauthorized' } as const;
    if (current && current.sessionId !== sessionId) return { kind: 'busy' } as const;

    const preview: Preview = current ?? { sessionId, codes: new Map(), viewers: new Map() };
    const code = this.issue(preview.codes, login, mode, codeLifetime);
    if (!code) return { kind: 'limit' } as const;
    this.preview = preview;
    return { kind: 'opened', code } as const;
  }

  exchange(code: string): string | undefined {
    const preview = this.activePreview();
    const grant = preview?.codes.get(code);
    if (!preview || !grant) return;
    preview.codes.delete(code);
    if (!this.valid(grant)) return;
    return this.issue(preview.viewers, grant.login, grant.mode, previewSessionLifetime * 1000);
  }

  authorized(viewer: string): boolean {
    return this.access(viewer) !== undefined;
  }

  access(viewer: string): { sessionId: string; mode: PreviewMode } | undefined {
    const preview = this.activePreview();
    const grant = preview?.viewers.get(viewer);
    if (!preview || !grant) return;
    if (this.valid(grant)) return { sessionId: preview.sessionId, mode: grant.mode };
    preview.viewers.delete(viewer);
  }

  stop(sessionId: string): boolean {
    const current = this.activePreview();
    if (current && current.sessionId !== sessionId) return false;
    this.clear();
    return true;
  }

  clear(): void {
    this.preview = undefined;
  }

  private activePreview(): Preview | undefined {
    if (this.preview && !this.deps.sessionActive(this.preview.sessionId)) this.preview = undefined;
    return this.preview;
  }

  private valid(grant: Grant): boolean {
    return grant.expiresAt > this.deps.now() && this.deps.loginValid(grant.login);
  }

  private issue(
    grants: Map<string, Grant>,
    login: AuthorizationSessionId,
    mode: PreviewMode,
    lifetime: number,
  ): string | undefined {
    if (grants.size >= grantLimit) {
      for (const [token, grant] of grants) {
        if (!this.valid(grant)) grants.delete(token);
      }
      if (grants.size >= grantLimit) return;
    }
    const token = this.deps.token();
    grants.set(token, { login, expiresAt: this.deps.now() + lifetime, mode });
    return token;
  }
}
