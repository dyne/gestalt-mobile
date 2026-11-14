/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AvailableSkill } from '../../features/skills/model/skill-profile.js';
import type { ReadinessEvidence } from '../retrieval/readiness-evidence.js';
import type { RetrievalReadiness } from '../../../shared/contracts/retrieval-readiness.js';
import type { RepositoryReadiness } from '../retrieval/repository-readiness.js';
import type { StartupGuidance } from './startup-guidance.js';

export type CodexCapabilityInput = {
  cwd: string;
  deadline: number;
  rpc: { request(method: string, params: unknown): Promise<unknown> };
  skills: readonly AvailableSkill[];
  skillsConfig: readonly { path: string; enabled: boolean }[];
  config: Record<string, unknown>;
  start: boolean;
  approvalPolicy?: string;
  /** Shared native readback for the combined adapter; null means unavailable. */
  nativeConfig?: Record<string, unknown> | null;
  /** Only fresh durable sessions install stable guidance; discovery probes omit it. */
  startup?: boolean;
};

export type CodexCapabilityState = {
  config: Record<string, unknown>;
  skillsConfig: readonly { path: string; enabled: boolean }[];
  ready: boolean;
  diagnostic?: string;
  instructionBlock?: string;
  startup?: StartupGuidance;
  /** Fresh replacement boundary only; no capability, provider or scratch preparation. */
  prepareFreshStartup?(): Promise<void>;
  backendPreparation?: { status: 'starting' | 'unavailable'; reason?: string };
  /** Verified optional capability guidance inserted only when starting a root turn. */
  turnInstructions?: string;
  evidence?: ReadinessEvidence;
  readiness?: RetrievalReadiness;
  repositories?: RepositoryReadiness;
  capabilities?: readonly {
    skillName: string;
    serverName: string;
    ready: boolean;
    diagnostic?: string;
    readiness?: RetrievalReadiness;
  }[];
  deadline: number;
  /** Connection observation gets its own allowance after native thread startup. */
  verificationTimeoutMs?: number;
  fallback(): void;
};
