/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  watch,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isPlanSignalReason } from '../../../shared/contracts/plan-signal.js';
import { basename, dirname, join } from 'node:path';

import type {
  PlanStatusLease,
  PlanStatusSource,
  PlanStatusUpdate,
} from '../../features/plans/application/ports.js';
import { parseSupervisedPlan } from '../../features/plans/application/parse-supervised-plan.js';
import { isPlanPathWithinWorkspace } from '../../features/plans/application/parse-supervised-plan.js';
import { ORG_PLAN_CAPABILITIES } from './org-plan-capabilities.js';

const statusFileSuffix = '.plan-status.json';

type Watcher = Awaited<ReturnType<typeof watch>>;
type DismissalFilesystem = Readonly<{ writeFile: typeof writeFile; rename: typeof rename }>;
type PlanReadFilesystem = Readonly<{ readFile: typeof readFile; realpath: typeof realpath }>;
type StatusRemovalFilesystem = Readonly<{ rm: typeof rm }>;

export class FilesystemPlanStatusSource implements PlanStatusSource {
  private readonly leases = new Map<string, ActiveLease>();
  private readonly activeStatusPaths = new Map<string, string>();

  constructor(
    private readonly dismissalDirectory: string,
    private readonly dismissalFilesystem: DismissalFilesystem = { writeFile, rename },
    private readonly planReadFilesystem: PlanReadFilesystem = { readFile, realpath },
    private readonly statusRemovalFilesystem: StatusRemovalFilesystem = { rm },
  ) {}

  async open(
    session: Readonly<{ id: string; workspacePath: string }>,
    listener: (update: PlanStatusUpdate) => void,
  ): Promise<PlanStatusLease> {
    this.leases.get(session.id)?.close();
    if (!(await stat(session.workspacePath)).isDirectory())
      throw new Error('WORKSPACE_NOT_DIRECTORY');
    const statusDirectory = planStatusDirectoryPath(session.workspacePath, session.id);
    await mkdir(this.dismissalDirectory, { recursive: true, mode: 0o700 });
    await mkdir(statusDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await Promise.all([chmod(this.dismissalDirectory, 0o700), chmod(statusDirectory, 0o700)]);
    }

    const lease = new ActiveLease(
      statusDirectory,
      session.id,
      session.workspacePath,
      listener,
      this.planReadFilesystem,
      (identity) => this.isDismissed(session.id, identity),
      (statusPath) => this.activeStatusPaths.set(session.id, statusPath),
      () => {
        this.leases.delete(session.id);
        this.activeStatusPaths.delete(session.id);
      },
    );
    this.leases.set(session.id, lease);
    await lease.start();
    return lease;
  }

  /** Explicit attachments use the same durable publication and watchers as helper updates. */
  async attach(
    session: Readonly<{ id: string; workspacePath: string }>,
    requestedPath: string,
    listener: (update: PlanStatusUpdate) => void,
    reason = 'supervision-start',
  ): Promise<void> {
    const [planPath, workspacePath] = await Promise.all([
      this.planReadFilesystem.realpath(requestedPath),
      this.planReadFilesystem.realpath(session.workspacePath),
    ]);
    if (!isPlanPathWithinWorkspace(planPath, workspacePath))
      throw new Error('PATH_OUTSIDE_WORKSPACE');
    const parsed = parseSupervisedPlan({
      source: await this.planReadFilesystem.readFile(planPath, 'utf8'),
      planPath,
      workspacePath,
    });
    if (parsed.kind !== 'available') throw new Error('PLAN_UNAVAILABLE');
    const directory = planStatusDirectoryPath(workspacePath, session.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const statusPath = planStatusFilePath(directory, planPath);
    const candidate = join(directory, `.${randomUUID()}.status.tmp`);
    try {
      await writeFile(
        candidate,
        JSON.stringify({
          schemaVersion: 1,
          planPath,
          reason,
          updatedAt: new Date().toISOString(),
          ...(parsed.plan.modelPolicyVersion
            ? {
                modelPolicyVersion: parsed.plan.modelPolicyVersion,
                requiredCapabilities: ['l1-model-policy-v1'],
              }
            : {}),
        }),
        { mode: 0o600 },
      );
      await rename(candidate, statusPath);
    } finally {
      await rm(candidate, { force: true }).catch(() => {});
    }
    // Explicit validated attachment supersedes incompatible pointer hints in
    // this session only. Plan files are never removed or rewritten here.
    for (const filename of await readdir(directory)) {
      const stalePath = join(directory, filename);
      if (stalePath === statusPath || !filename.endsWith(statusFileSuffix)) continue;
      const stale = await this.planReadFilesystem.readFile(stalePath, 'utf8').catch(() => '');
      if (declaresModelPolicy(stale) && !parseSignal(stale)) await rm(stalePath, { force: true });
    }
    const identity = createHash('sha256').update(planPath).digest('hex');
    const dismissed = new Set(await this.dismissed(session.id));
    if (dismissed.delete(identity)) await this.saveDismissals(session.id, dismissed);
    const lease = this.leases.get(session.id);
    if (!lease) await this.open(session, listener);
    await this.leases.get(session.id)?.selectAttachment(statusPath);
  }

  closeAll(): void {
    for (const lease of this.leases.values()) lease.close();
    this.leases.clear();
  }

  async refresh(sessionId: string): Promise<PlanStatusUpdate | null> {
    return (await this.leases.get(sessionId)?.refreshCurrent()) ?? null;
  }

  async remove(sessionId: string, identity?: string): Promise<void> {
    const statusPath = this.activeStatusPaths.get(sessionId);
    const signal = statusPath ? await this.readStatusForRollback(statusPath) : undefined;
    if (statusPath) {
      try {
        await this.statusRemovalFilesystem.rm(statusPath, { force: true });
      } catch (error) {
        this.leases.get(sessionId)?.allowRepeatedUpdate();
        throw error;
      }
    }
    try {
      if (identity) await this.dismiss(sessionId, identity);
    } catch (error) {
      this.leases.get(sessionId)?.allowRepeatedUpdate();
      if (signal !== undefined && statusPath) await this.restoreStatus(statusPath, signal);
      throw error;
    }
  }

  private async readStatusForRollback(statusPath: string): Promise<string | undefined> {
    try {
      return await this.planReadFilesystem.readFile(statusPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async restoreStatus(statusPath: string, signal: string): Promise<void> {
    const candidate = join(dirname(statusPath), `.${randomUUID()}.status.tmp`);
    try {
      await writeFile(candidate, signal, { mode: 0o600 });
      await rename(candidate, statusPath);
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async dismiss(sessionId: string, identity: string): Promise<void> {
    const dismissed = await this.dismissed(sessionId);
    const next = new Set(dismissed).add(identity);
    await this.saveDismissals(sessionId, next);
  }

  private async saveDismissals(sessionId: string, next: Set<string>): Promise<void> {
    const path = this.dismissalPath(sessionId);
    const candidate = join(this.dismissalDirectory, `.${randomUUID()}.dismissals.tmp`);
    try {
      await this.dismissalFilesystem.writeFile(candidate, JSON.stringify([...next]), {
        mode: 0o600,
      });
      await this.dismissalFilesystem.rename(candidate, path);
    } catch (error) {
      await rm(candidate, { force: true }).catch(() => {});
      throw error;
    }
    this.dismissedBySession.set(sessionId, next);
  }

  private async isDismissed(sessionId: string, identity: string): Promise<boolean> {
    return (await this.dismissed(sessionId)).has(identity);
  }

  private dismissedBySession = new Map<string, Set<string>>();

  private async dismissed(sessionId: string): Promise<Set<string>> {
    const cached = this.dismissedBySession.get(sessionId);
    if (cached) return cached;
    try {
      const values: unknown = JSON.parse(
        await this.planReadFilesystem.readFile(this.dismissalPath(sessionId), 'utf8'),
      );
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string'))
        throw new Error();
      const dismissed = new Set(values);
      this.dismissedBySession.set(sessionId, dismissed);
      return dismissed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const absent = new Set<string>();
      this.dismissedBySession.set(sessionId, absent);
      return absent;
    }
  }

  private dismissalPath(sessionId: string): string {
    return join(
      this.dismissalDirectory,
      `${createHash('sha256').update(sessionId).digest('hex')}.dismissals.json`,
    );
  }
}

export function planStatusDirectoryPath(workspacePath: string, sessionId: string): string {
  const opaqueSessionId = createHash('sha256').update(sessionId).digest('hex');
  return join(workspacePath, '.gestalt', 'status', opaqueSessionId);
}

export function planStatusFilePath(statusDirectory: string, canonicalPlanPath: string): string {
  const opaquePlanId = createHash('sha256').update(canonicalPlanPath).digest('hex');
  return join(statusDirectory, `${opaquePlanId}${statusFileSuffix}`);
}

class ActiveLease implements PlanStatusLease {
  private watcher: Watcher | undefined;
  private planWatcher: Watcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private activeStatusPath: string | undefined;
  private activePlanPath: string | undefined;
  private lastEmittedUpdate: string | undefined;
  private policyBlockedStatusPath: string | undefined;
  /** Retire older reads when mandatory rejection or explicit recovery changes admission. */
  private policySelectionRevision = 0;

  constructor(
    readonly statusDirectory: string,
    private readonly sessionId: string,
    private readonly workspacePath: string,
    private readonly listener: (update: PlanStatusUpdate) => void,
    private readonly planReadFilesystem: PlanReadFilesystem,
    private readonly isDismissed: (identity: string) => Promise<boolean>,
    private readonly onActiveStatusPath: (statusPath: string) => void,
    private readonly onClose: () => void,
  ) {}

  async start(): Promise<void> {
    await this.refreshLatest();
    try {
      this.watcher = watch(this.statusDirectory, { persistent: false });
      void this.consumeChanges();
    } catch {
      this.emitUnavailable();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.planDebounce) clearTimeout(this.planDebounce);
    void this.watcher?.return?.();
    void this.planWatcher?.return?.();
    this.onClose();
  }

  async remove(): Promise<void> {
    if (this.activeStatusPath) await rm(this.activeStatusPath, { force: true });
  }

  allowRepeatedUpdate(): void {
    this.lastEmittedUpdate = undefined;
  }

  private async consumeChanges(): Promise<void> {
    try {
      for await (const event of this.watcher!) {
        if (this.closed) return;
        if (!event.filename) {
          this.scheduleRefresh();
          continue;
        }
        const filename = basename(String(event.filename));
        if (!filename.endsWith(statusFileSuffix)) continue;
        this.scheduleRefresh(join(this.statusDirectory, filename));
      }
    } catch {
      if (!this.closed) this.emitUnavailable();
    }
  }

  private pendingStatusPath: string | undefined;

  private scheduleRefresh(statusPath?: string): void {
    this.pendingStatusPath = statusPath;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      const pendingStatusPath = this.pendingStatusPath;
      this.pendingStatusPath = undefined;
      void (pendingStatusPath ? this.refreshPath(pendingStatusPath) : this.refreshLatest());
    }, 25);
  }

  private watchActivePlan(planPath: string): void {
    if (this.activePlanPath === planPath && this.planWatcher) return;
    void this.planWatcher?.return?.();
    this.activePlanPath = planPath;
    void (async () => {
      try {
        this.planWatcher = watch(dirname(planPath), { persistent: false });
        for await (const event of this.planWatcher) {
          if (this.closed || basename(String(event.filename ?? '')) !== basename(planPath))
            continue;
          this.schedulePlanRefresh();
        }
      } catch {
        // The status signal remains the bounded recovery path.
      }
    })();
  }

  private planDebounce: ReturnType<typeof setTimeout> | undefined;
  private schedulePlanRefresh(): void {
    if (this.planDebounce) clearTimeout(this.planDebounce);
    this.planDebounce = setTimeout(() => {
      this.planDebounce = undefined;
      if (this.activeStatusPath) void this.refreshPath(this.activeStatusPath);
    }, 25);
  }

  async refreshCurrent(): Promise<PlanStatusUpdate | null> {
    // Admission/checkpoint reads must see mandatory publications even while the
    // directory watcher is debouncing an update to a different status path.
    return this.refreshLatest();
  }

  async selectAttachment(statusPath: string): Promise<void> {
    this.policySelectionRevision += 1;
    const blocked = this.policyBlockedStatusPath;
    const update = await this.refreshPath(statusPath, undefined, true);
    if (update?.kind !== 'updated') throw new Error('PLAN_UNAVAILABLE');
    if (update?.kind === 'updated' && blocked && blocked !== statusPath)
      await rm(blocked, { force: true });
  }

  async refreshLatest(): Promise<PlanStatusUpdate | null> {
    const policyRevision = this.policySelectionRevision;
    try {
      const candidates = (await readdir(this.statusDirectory))
        .filter((filename) => filename.endsWith(statusFileSuffix))
        .map((filename) => join(this.statusDirectory, filename));
      const signals = await Promise.all(
        candidates.map(async (statusPath) => {
          const [source, metadata] = await Promise.all([
            this.planReadFilesystem.readFile(statusPath, 'utf8').catch(() => ''),
            stat(statusPath).catch(() => undefined),
          ]);
          return {
            statusPath,
            signal: parseSignal(source),
            modifiedAt: metadata?.mtimeMs ?? 0,
            policyRequired: declaresModelPolicy(source),
          };
        }),
      );
      const latest = signals
        .filter(
          (candidate): candidate is typeof candidate & { signal: PlanStatusSignal } =>
            candidate.signal !== null,
        )
        .sort(
          (left, right) =>
            right.signal.updatedAt.localeCompare(left.signal.updatedAt) ||
            right.modifiedAt - left.modifiedAt,
        )[0];
      if (policyRevision !== this.policySelectionRevision) return null;
      const invalidPolicy = signals
        .filter((candidate) => !candidate.signal && candidate.policyRequired)
        .sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
      if (invalidPolicy && (!latest || invalidPolicy.modifiedAt >= latest.modifiedAt)) {
        this.policyBlockedStatusPath = invalidPolicy.statusPath;
        return !this.closed ? this.emitUnavailable(true) : null;
      }
      return latest
        ? this.refreshPath(latest.statusPath, latest.signal, true)
        : this.activeStatusPath
          ? this.refreshPath(this.activeStatusPath, undefined, true)
          : null;
    } catch {
      return !this.closed ? this.emitUnavailable() : null;
    }
  }

  private async refreshPath(
    statusPath: string,
    parsedSignal?: PlanStatusSignal,
    selectedLatest = false,
  ): Promise<PlanStatusUpdate | null> {
    if (
      this.policyBlockedStatusPath &&
      !selectedLatest &&
      statusPath !== this.policyBlockedStatusPath
    )
      return this.refreshLatest();
    let policyRequired = parsedSignal?.modelPolicyVersion === 1;
    const policyRevision = this.policySelectionRevision;
    try {
      const source = parsedSignal
        ? null
        : await this.planReadFilesystem.readFile(statusPath, 'utf8');
      policyRequired ||= source !== null && declaresModelPolicy(source);
      const signal = parsedSignal ?? parseSignal(source!);
      if (!signal) throw new Error('INVALID_PLAN_STATUS');
      const [planPath, workspacePath] = await Promise.all([
        this.planReadFilesystem.realpath(signal.planPath),
        this.planReadFilesystem.realpath(this.workspacePath),
      ]);
      if (!isPlanPathWithinWorkspace(planPath, workspacePath))
        throw new Error('PATH_OUTSIDE_WORKSPACE');
      const identity = createHash('sha256').update(planPath).digest('hex');
      if (await this.isDismissed(identity)) return null;
      const result = parseSupervisedPlan({
        source: await this.planReadFilesystem.readFile(planPath, 'utf8'),
        planPath,
        workspacePath,
      });
      if (result.kind === 'available') {
        policyRequired ||= result.plan.modelPolicyVersion === 1;
        if (result.plan.modelPolicyVersion !== signal.modelPolicyVersion)
          throw new Error('MODEL_POLICY_PUBLICATION_MISMATCH');
        if (!this.closed && !(await this.isDismissed(identity)) && !this.closed) {
          if (policyRevision !== this.policySelectionRevision) return null;
          const previousStatusPath = this.activeStatusPath;
          this.policyBlockedStatusPath = undefined;
          this.activeStatusPath = statusPath;
          this.watchActivePlan(planPath);
          this.onActiveStatusPath(statusPath);
          const update = {
            kind: 'updated',
            plan: result.plan,
            identity,
            planPath,
            reason: signal.reason,
          } as const;
          const serializedUpdate = JSON.stringify(update);
          if (serializedUpdate !== this.lastEmittedUpdate) {
            this.lastEmittedUpdate = serializedUpdate;
            this.listener(update);
          }
          if (previousStatusPath && previousStatusPath !== statusPath)
            await rm(previousStatusPath, { force: true }).catch(() => {});
          return update;
        }
      } else if (!this.closed) {
        if (policyRevision !== this.policySelectionRevision) return null;
        policyRequired ||= result.reason === 'INVALID_MODEL_POLICY';
        if (policyRequired) this.policyBlockedStatusPath = statusPath;
        return this.emitUnavailable(policyRequired);
      }
      return null;
    } catch (error) {
      if (policyRevision !== this.policySelectionRevision) return null;
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        this.activeStatusPath !== undefined &&
        statusPath !== this.activeStatusPath
      )
        return null;
      if (policyRequired) this.policyBlockedStatusPath = statusPath;
      return !this.closed ? this.emitUnavailable(policyRequired) : null;
    }
  }

  private emitUnavailable(modelPolicyRequired = false): PlanStatusUpdate {
    if (modelPolicyRequired) this.policySelectionRevision += 1;
    this.lastEmittedUpdate = undefined;
    const update = {
      kind: 'unavailable',
      code: 'PLAN_STATUS_UNAVAILABLE',
      ...(modelPolicyRequired ? { modelPolicyRequired: true as const } : {}),
    } as const;
    this.listener(update);
    return update;
  }
}

/** Recognize mandatory policy even when its version/capability envelope cannot be parsed. */
function declaresModelPolicy(source: string): boolean {
  return /"modelPolicyVersion"\s*:|"l1-model-policy[^"\r\n]*"/.test(source);
}

type PlanStatusSignal = Readonly<{
  planPath: string;
  updatedAt: string;
  modelPolicyVersion?: 1;
  reason: import('../../features/plans/application/ports.js').PlanSignalReason | null;
}>;

function parseSignal(source: string): PlanStatusSignal | null {
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object') return null;
    const signal = value as Record<string, unknown>;
    if (signal.schemaVersion !== 1 || typeof signal.planPath !== 'string') return null;
    if (typeof signal.reason !== 'string' || !isRfc3339Utc(signal.updatedAt)) return null;
    const required = signal.requiredCapabilities;
    if (
      required !== undefined &&
      (!Array.isArray(required) ||
        required.some(
          (capability) =>
            typeof capability !== 'string' ||
            !ORG_PLAN_CAPABILITIES.split(',').includes(capability),
        ))
    )
      return null;
    if (
      signal.modelPolicyVersion !== undefined &&
      (signal.modelPolicyVersion !== 1 ||
        !Array.isArray(required) ||
        !required.includes('l1-model-policy-v1'))
    )
      return null;
    if (
      Array.isArray(required) &&
      required.includes('l1-model-policy-v1') &&
      signal.modelPolicyVersion !== 1
    )
      return null;
    return {
      planPath: signal.planPath,
      updatedAt: signal.updatedAt as string,
      ...(signal.modelPolicyVersion === 1 ? { modelPolicyVersion: 1 } : {}),
      reason: isPlanSignalReason(signal.reason) ? signal.reason : null,
    };
  } catch {
    return null;
  }
}

function isRfc3339Utc(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
